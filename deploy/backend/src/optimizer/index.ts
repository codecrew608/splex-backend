import type { FastifyInstance } from "fastify";
import type { PlanTier } from "../shared-types.js";
import type { ModelRegistryRow } from "../types/index.js";
import { isProEnabled } from "../pro/gate.js";
import type { OptimizationMethod, OptimizationOutcome, OptimizationBypassReason } from "./types.js";
import { estimateTokens } from "./tokenEstimate.js";
import { applyDeterministicOptimization } from "./deterministic.js";
import { extractProtectedContent, restoreProtectedContent } from "./protect.js";
import { isPlanTierEligibleForOptimization, shouldAttemptSemanticOptimization, isNetBenefitPositive } from "./decision.js";
import { resolveOptimizerModelCandidates, resolveOptimizerModelPricing } from "./model.js";
import { runSemanticOptimization } from "./semantic.js";
import { validateOptimizedOutput } from "./validate.js";
import { recordOptimizationOutcome } from "./telemetry.js";

// The Prompt Optimizer's single entry point. Sits between the CURRENT
// turn's user message and the downstream model call in handlers/chat.ts —
// deliberately never conversation history, the system prompt, or memory
// summaries. Those are a separate, larger concern (spec item 15) that
// this pass does not attempt; touching persisted history correctly is a
// meaningfully bigger and riskier problem than compressing one turn's
// text, and is a documented gap here, not a silent one.
//
// Pro-only by explicit product decision: isPlanTierEligibleForOptimization
// is the FIRST check, before anything else runs, and there is no
// independent feature flag for this — it reuses SPLEX_PRO_ENABLED, the
// same single source of truth as the rest of the pro/ surface, rather
// than adding a second flag for one more piece of an already-gated tier.
//
// Pipeline: gate -> deterministic (Layer A, always) -> protect -> decide
// whether Layer B is worth it -> semantic (Layer B, maybe) -> validate ->
// economic check -> outcome. Every exit point returns a text that is
// SAFE TO SEND — the caller never has to branch on wasOptimized to know
// what to use.
export interface MaybeOptimizePromptParams {
  fastify: FastifyInstance;
  planTier: PlanTier;
  userId: string;
  // The assistant message row this turn is already writing to (inserted
  // before this is called, per handlers/chat.ts's own durable-persistence
  // ordering) — telemetry links to it, matching cortex_decisions' own
  // message_id-keyed shape.
  messageId: string;
  text: string;
  targetModel: ModelRegistryRow;
  signal?: AbortSignal;
}

export async function maybeOptimizePrompt(params: MaybeOptimizePromptParams): Promise<OptimizationOutcome> {
  const { fastify, planTier, userId, messageId, text, targetModel, signal } = params;
  const originalTokensEst = estimateTokens(text);

  if (!isPlanTierEligibleForOptimization(planTier)) {
    // No telemetry row: every non-Pro message (the overwhelming majority
    // of all traffic) would otherwise write an identical, uninteresting
    // "not_eligible" row forever. handlers/chat.ts's call site already
    // gates on plan tier before calling this at all — this check only
    // exists as defense in depth (see decision.ts's own doc comment) and
    // should never actually fire in production.
    return bypassOutcome(text, "not_eligible", originalTokensEst);
  }

  if (!isProEnabled(fastify)) {
    return finalizeAndRecord(fastify, messageId, userId, bypassOutcome(text, "flag_disabled", originalTokensEst));
  }

  // Protect FIRST, from the raw original, BEFORE Layer A ever runs.
  // Getting this order backwards is a real, non-obvious bug: Layer A's
  // whitespace normalization collapses any run of spaces/tabs, including
  // Python's own significant indentation inside a code block — running it
  // on raw text before code/JSON/URLs are pulled out corrupts exactly the
  // content this file most needs to protect. Once extracted, protected
  // spans are opaque single-token placeholders, so Layer A's cleanup on
  // the REMAINING text is safe.
  const { text: protectedText, spans } = extractProtectedContent(text);

  // Layer A — always runs. Zero external cost, unconditionally safe (see
  // deterministic.ts's own header), so its (placeholder-restored) output
  // is the safe fallback baseline for every bypass/failure branch below
  // rather than the raw original — no correctness cost to preferring it,
  // and it's still a real (if small) win over doing nothing.
  const deterministic = applyDeterministicOptimization(protectedText);
  const preSemanticText = deterministic.text;

  const candidates = await resolveOptimizerModelCandidates(fastify, planTier);
  const eligibility = shouldAttemptSemanticOptimization(preSemanticText, candidates.length > 0);
  if (!eligibility.eligible) {
    return finalizeAndRecord(
      fastify, messageId, userId,
      deterministicOnlyOutcome(restoreProtectedContent(deterministic.text, spans), deterministic.changed, originalTokensEst, eligibility.reason),
    );
  }

  const semanticResult = await runSemanticOptimization({ fastify, planTier, userId, preSemanticText, signal });
  if (!semanticResult) {
    return finalizeAndRecord(
      fastify, messageId, userId,
      deterministicOnlyOutcome(restoreProtectedContent(deterministic.text, spans), deterministic.changed, originalTokensEst, "semantic_call_failed"),
    );
  }

  const restoredFinalText = restoreProtectedContent(semanticResult.output, spans);
  const pricing = await resolveOptimizerModelPricing(fastify, semanticResult.modelUsed);
  const optimizerCostUsd =
    (semanticResult.inputTokens / 1_000_000) * pricing.costPerMillionInput +
    (semanticResult.outputTokens / 1_000_000) * pricing.costPerMillionOutput;

  const validation = validateOptimizedOutput({
    originalText: text,
    preSemanticText,
    semanticOutputRaw: semanticResult.output,
    restoredFinalText,
  });

  if (!validation.passed) {
    fastify.log.info({ reason: validation.failureReason }, "prompt optimizer: semantic output failed validation, falling back to deterministic-only text");
    const outcome = deterministicOnlyOutcome(restoreProtectedContent(deterministic.text, spans), deterministic.changed, originalTokensEst, "validation_failed");
    outcome.optimizerModel = semanticResult.modelUsed;
    outcome.optimizerCostUsd = optimizerCostUsd;
    outcome.optimizerLatencyMs = semanticResult.latencyMs;
    outcome.netSavingsUsd = -optimizerCostUsd;
    outcome.validationPassed = false;
    return finalizeAndRecord(fastify, messageId, userId, outcome);
  }

  const optimizedTokensEst = estimateTokens(restoredFinalText);
  const tokensSaved = Math.max(0, originalTokensEst - optimizedTokensEst);
  const downstreamSavingsUsd = (tokensSaved / 1_000_000) * targetModel.cost_per_million_input;

  if (!isNetBenefitPositive(originalTokensEst, optimizedTokensEst, downstreamSavingsUsd, optimizerCostUsd)) {
    const outcome = deterministicOnlyOutcome(restoreProtectedContent(deterministic.text, spans), deterministic.changed, originalTokensEst, "negligible_or_negative_savings");
    outcome.optimizerModel = semanticResult.modelUsed;
    outcome.optimizerCostUsd = optimizerCostUsd;
    outcome.optimizerLatencyMs = semanticResult.latencyMs;
    outcome.downstreamSavingsUsd = downstreamSavingsUsd;
    outcome.netSavingsUsd = downstreamSavingsUsd - optimizerCostUsd;
    outcome.validationPassed = true;
    return finalizeAndRecord(fastify, messageId, userId, outcome);
  }

  const outcome: OptimizationOutcome = {
    text: restoredFinalText,
    wasOptimized: true,
    method: "semantic",
    originalTokensEst,
    optimizedTokensEst,
    reductionPct: reductionPct(originalTokensEst, optimizedTokensEst),
    optimizerModel: semanticResult.modelUsed,
    optimizerCostUsd,
    optimizerLatencyMs: semanticResult.latencyMs,
    downstreamSavingsUsd,
    netSavingsUsd: downstreamSavingsUsd - optimizerCostUsd,
    bypassReason: null,
    validationPassed: true,
  };
  return finalizeAndRecord(fastify, messageId, userId, outcome);
}

function reductionPct(original: number, optimized: number): number {
  if (original <= 0 || optimized >= original) return 0;
  return (original - optimized) / original;
}

function bypassOutcome(text: string, reason: OptimizationBypassReason, originalTokensEst: number): OptimizationOutcome {
  return {
    text,
    wasOptimized: false,
    method: "none",
    originalTokensEst,
    optimizedTokensEst: originalTokensEst,
    reductionPct: 0,
    optimizerModel: null,
    optimizerCostUsd: 0,
    optimizerLatencyMs: 0,
    downstreamSavingsUsd: 0,
    netSavingsUsd: 0,
    bypassReason: reason,
    validationPassed: null,
  };
}

// Shared shape for every branch that settles on Layer A's output (Layer B
// was skipped, failed, failed validation, or wasn't worth its own cost).
// Returns a mutable object deliberately — a couple of call sites above
// overlay optimizer cost/model fields that only apply when a semantic
// attempt actually happened before falling back.
function deterministicOnlyOutcome(
  deterministicText: string,
  changed: boolean,
  originalTokensEst: number,
  bypassReason: OptimizationBypassReason | null,
): OptimizationOutcome {
  const optimizedTokensEst = estimateTokens(deterministicText);
  const method: OptimizationMethod = changed ? "deterministic" : "none";
  return {
    text: deterministicText,
    wasOptimized: changed,
    method,
    originalTokensEst,
    optimizedTokensEst,
    reductionPct: reductionPct(originalTokensEst, optimizedTokensEst),
    optimizerModel: null,
    optimizerCostUsd: 0,
    optimizerLatencyMs: 0,
    downstreamSavingsUsd: 0,
    netSavingsUsd: 0,
    bypassReason,
    validationPassed: null,
  };
}

// Telemetry is fire-and-forget (spec item 19): logged, never awaited in a
// way that could delay the turn, never allowed to throw past this
// function. The caller needs `outcome.text` synchronously — it's what
// gets sent to the model THIS turn — so this returns immediately and lets
// the insert land alongside rather than serialize before it.
function finalizeAndRecord(fastify: FastifyInstance, messageId: string, userId: string, outcome: OptimizationOutcome): OptimizationOutcome {
  void recordOptimizationOutcome(fastify, messageId, userId, outcome).catch(() => {});
  return outcome;
}
