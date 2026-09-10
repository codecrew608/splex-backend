// SPLEX Prompt Optimizer — shared types.
//
// Sits between the current turn's user message and the downstream model
// call in handlers/chat.ts. Never touches conversation history, memory
// summaries, or the system prompt — see index.ts's own header for why the
// scope is deliberately limited to the current turn's text.

export type OptimizationMethod = "none" | "deterministic" | "semantic";

// Every reason optimization did NOT reach (or accept) a semantic rewrite.
// Recorded on every outcome — including successful ones, where it stays
// null — so telemetry can answer "why wasn't this optimized" without
// guessing from the other fields.
export type OptimizationBypassReason =
  | "flag_disabled"
  | "not_eligible" // multimodal content, empty text, etc. — caller-level skip
  | "below_threshold"
  | "no_optimizer_model_available"
  | "semantic_call_failed"
  | "semantic_call_timeout"
  | "validation_failed"
  | "negligible_or_negative_savings";

export interface OptimizationOutcome {
  // What to actually send downstream — optimized text, or the original
  // unchanged. Callers never need to branch on wasOptimized to know what
  // to send; this field is always the right answer.
  text: string;
  wasOptimized: boolean;
  method: OptimizationMethod;
  originalTokensEst: number;
  optimizedTokensEst: number;
  // 0 when optimizedTokensEst >= originalTokensEst (never negative-signed
  // in a way that reads as a savings when there was none).
  reductionPct: number;
  optimizerModel: string | null;
  optimizerCostUsd: number;
  optimizerLatencyMs: number;
  downstreamSavingsUsd: number;
  netSavingsUsd: number;
  bypassReason: OptimizationBypassReason | null;
  // null = the semantic layer never ran (bypassed before that point), so
  // there was nothing to validate.
  validationPassed: boolean | null;
}

export interface ProtectedExtraction {
  // Original text with every protected span replaced by an opaque
  // placeholder token.
  text: string;
  // Original content of each span, indexed by placeholder number.
  spans: string[];
}
