import type { PlanTier } from "@splex/shared-types";
import type { OptimizationBypassReason } from "./types.js";
import { estimateTokens } from "./tokenEstimate.js";

// Spec item 3: "Do NOT optimize every request." Below this size a
// round-trip to even a free/cheap model costs more in latency than the
// prompt could plausibly save — "What is 2+2?" (≈5 tokens) must never
// trigger a semantic call. No benchmark data exists yet to tune this
// precisely (see this session's own final report for that honesty), so
// it is a deliberately conservative, clearly-documented starting default:
// short enough to catch genuinely verbose messages, long enough that
// ordinary short questions never reach the semantic layer. Tunable.
export const MIN_TOKENS_FOR_SEMANTIC = 80;

export interface OptimizationEligibility {
  eligible: boolean;
  reason: OptimizationBypassReason | null;
}

// The FIRST check, always — see this function's callers. Prompt
// optimization is a Pro-only capability (explicit product decision, not
// an engineering default): Free and Starter chat is completely untouched
// by this feature, regardless of message size or the Pro flag's state.
export function isPlanTierEligibleForOptimization(planTier: PlanTier): boolean {
  return planTier === "pro";
}

// Deterministic pre-check for whether the SEMANTIC (Layer B) step is worth
// attempting at all, run AFTER Layer A's cleanup (so the size check
// reflects what's actually left to compress, not the pre-cleanup size).
// This is intentionally simple and legible rather than a weighted scoring
// function — every input is either a hard gate (no model available) or a
// single size threshold, so a reader can predict the outcome without
// running the code.
export function shouldAttemptSemanticOptimization(cleanedText: string, hasOptimizerModel: boolean): OptimizationEligibility {
  if (!hasOptimizerModel) {
    return { eligible: false, reason: "no_optimizer_model_available" };
  }
  const tokens = estimateTokens(cleanedText);
  if (tokens < MIN_TOKENS_FOR_SEMANTIC) {
    return { eligible: false, reason: "below_threshold" };
  }
  return { eligible: true, reason: null };
}

// Spec item 24's economic rule, applied with REAL numbers from the actual
// call that just happened (model_registry pricing + real usage), not
// estimates. Net benefit must be genuinely positive, and the reduction
// itself must be meaningful — a 2% reduction technically "saves" money but
// is well within the noise of the ~4-chars/token estimate this whole
// decision layer runs on, so it is treated as no better than zero.
const MIN_MEANINGFUL_REDUCTION_PCT = 0.10;

export function isNetBenefitPositive(originalTokens: number, optimizedTokens: number, downstreamSavingsUsd: number, optimizerCostUsd: number): boolean {
  if (optimizedTokens >= originalTokens) return false;
  const reductionPct = (originalTokens - optimizedTokens) / originalTokens;
  if (reductionPct < MIN_MEANINGFUL_REDUCTION_PCT) return false;
  return downstreamSavingsUsd > optimizerCostUsd;
}
