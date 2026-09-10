import type { FastifyInstance } from "fastify";
import type { PlanTier } from "@splex/shared-types";
import { applyDeterministicOptimization } from "../optimizer/deterministic.js";
import { extractProtectedContent, restoreProtectedContent } from "../optimizer/protect.js";
import { shouldAttemptSemanticOptimization, isNetBenefitPositive } from "../optimizer/decision.js";
import { resolveOptimizerModelCandidates, resolveOptimizerModelPricing } from "../optimizer/model.js";
import { runSemanticOptimization } from "../optimizer/semantic.js";
import { validateOptimizedOutput } from "../optimizer/validate.js";
import { estimateTokens } from "../optimizer/tokenEstimate.js";
import { OPENAI_CAPABILITIES } from "./providers/openai.js";
import { ANTHROPIC_CAPABILITIES } from "./providers/anthropic.js";
import { GEMINI_CAPABILITIES } from "./providers/gemini.js";
import { PERPLEXITY_CAPABILITIES } from "./providers/perplexity.js";
import { XAI_CAPABILITIES } from "./providers/xai.js";

// Wires the Prompt Optimizer (already committed, e42830d) into Pro
// workflow creation — verified missing before this file existed:
// createProWorkflow previously took the raw objective straight into
// classifyObjectiveComplexity/buildTaskExecutionGraph with no compression
// step at all.
//
// Deliberately NOT a call to optimizer/index.ts's maybeOptimizePrompt —
// that function is shaped for ordinary chat (one message, one messageId
// to link telemetry to, one target model the WHOLE prompt goes to) and a
// Pro objective is structurally different: there is no messages row for
// a workflow objective, and no single target model — the objective gets
// DECOMPOSED across however many different providers the graph ends up
// using, not sent whole to one. Forcing those two shapes through one
// function would mean either inventing a fake messageId/targetModel for
// Pro or growing maybeOptimizePrompt new optional-everything branches
// for a caller that doesn't fit its own premise. Composing the SAME
// underlying primitives (optimizer/deterministic.ts, protect.ts,
// decision.ts, semantic.ts, validate.ts — zero duplicated compression or
// validation logic) directly here is what "reuse, don't duplicate"
// actually means when two call sites are genuinely different shapes, not
// just superficially.
//
// Known, documented gap: no prompt_optimizer_outcomes telemetry row is
// written here (that table's message_id column is NOT NULL, and a
// workflow objective has no message to link to) — this optimization is
// silent from a telemetry standpoint. Acceptable for this pass; would
// need either a nullable message_id or a parallel workflow_id column to
// close.
export interface ObjectiveOptimizationOutcome {
  text: string;
  wasOptimized: boolean;
}

export async function optimizeProObjective(
  fastify: FastifyInstance,
  planTier: PlanTier,
  userId: string,
  objective: string,
): Promise<ObjectiveOptimizationOutcome> {
  const originalTokensEst = estimateTokens(objective);

  // Layer A + protection, identical order and reasoning to
  // optimizer/index.ts's own pipeline (protect BEFORE any whitespace
  // normalization — see that file's own bug-fix comment for why the
  // order matters).
  const { text: protectedText, spans } = extractProtectedContent(objective);
  const deterministic = applyDeterministicOptimization(protectedText);
  const preSemanticText = deterministic.text;
  const deterministicOnly = (): ObjectiveOptimizationOutcome => ({
    text: restoreProtectedContent(deterministic.text, spans),
    wasOptimized: deterministic.changed,
  });

  const candidates = await resolveOptimizerModelCandidates(fastify, planTier);
  const eligibility = shouldAttemptSemanticOptimization(preSemanticText, candidates.length > 0);
  if (!eligibility.eligible) return deterministicOnly();

  const semanticResult = await runSemanticOptimization({ fastify, planTier, userId, preSemanticText });
  if (!semanticResult) return deterministicOnly();

  const restoredFinalText = restoreProtectedContent(semanticResult.output, spans);
  const validation = validateOptimizedOutput({
    originalText: objective,
    preSemanticText,
    semanticOutputRaw: semanticResult.output,
    restoredFinalText,
  });
  if (!validation.passed) return deterministicOnly();

  const pricing = await resolveOptimizerModelPricing(fastify, semanticResult.modelUsed);
  const optimizerCostUsd =
    (semanticResult.inputTokens / 1_000_000) * pricing.costPerMillionInput +
    (semanticResult.outputTokens / 1_000_000) * pricing.costPerMillionOutput;

  const optimizedTokensEst = estimateTokens(restoredFinalText);
  const tokensSaved = Math.max(0, originalTokensEst - optimizedTokensEst);
  // No single target model for a Pro objective (item 24's economic gate
  // still applies — this just can't key off ONE provider's rate the way
  // ordinary chat does). Uses the average declared input cost across the
  // 5 Pro providers as a representative basis rather than skip the check.
  const avgInputCostPerMillion =
    [OPENAI_CAPABILITIES, ANTHROPIC_CAPABILITIES, GEMINI_CAPABILITIES, PERPLEXITY_CAPABILITIES, XAI_CAPABILITIES]
      .reduce((sum, c) => sum + c.costPerMillionInputUsd, 0) / 5;
  const downstreamSavingsUsd = (tokensSaved / 1_000_000) * avgInputCostPerMillion;

  if (!isNetBenefitPositive(originalTokensEst, optimizedTokensEst, downstreamSavingsUsd, optimizerCostUsd)) {
    return deterministicOnly();
  }

  return { text: restoredFinalText, wasOptimized: true };
}
