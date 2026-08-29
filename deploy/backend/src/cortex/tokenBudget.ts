import type { ComplexityLevel } from "../shared-types.js";
import type { ModelRegistryRow } from "../types/index.js";

// Central token-budget policy — the single place that decides how large an
// output max_tokens to request from OpenRouter for a real, user-facing
// generation. Root cause this fixes: streamCompletion() (the user-facing
// streamed chat path) never sent max_tokens at all, so OpenRouter fell back
// to the served model's own maximum (65536 for deepseek/deepseek-v4-flash-
// 0731) — and OpenRouter's pre-flight affordability check rejects a
// request against that ceiling even when actual usage would be a few
// hundred tokens, producing a 402 on an account that could easily have
// afforded the real generation. Every text-generating category maps to a
// tier here; image/audio/video/ppt don't (they call dedicated OpenRouter
// APIs, not chat/completions, and never reach this function).
export type TokenBudgetTier = "simple" | "medium" | "complex" | "deep_research";

const TIER_BUDGETS: Record<TokenBudgetTier, number> = {
  simple: 3072,
  medium: 6144,
  complex: 12288,
  deep_research: 16384,
};

// Cortex's complexity score reflects prompt *shape/length*, not category —
// a one-line "write a Python script that does X" can score "simple" while
// still needing real code-generation room. These categories get a tier
// floor regardless of what complexity scored.
const CATEGORY_MIN_TIER: Partial<Record<string, TokenBudgetTier>> = {
  coding: "medium",
  reasoning: "medium",
  math: "medium",
  web_search: "medium", // citations + synthesis, not a one-line answer
};

const TIER_ORDER: TokenBudgetTier[] = ["simple", "medium", "complex", "deep_research"];

function tierFor(category: string, complexity: ComplexityLevel): TokenBudgetTier {
  if (category === "deep_research") return "deep_research";
  const base: TokenBudgetTier = complexity === "complex" ? "complex" : complexity === "medium" ? "medium" : "simple";
  const categoryMin = CATEGORY_MIN_TIER[category];
  if (!categoryMin) return base;
  return TIER_ORDER.indexOf(categoryMin) > TIER_ORDER.indexOf(base) ? categoryMin : base;
}

// Never request more than this fraction of the model's context window as
// *output* — leaves room for the prompt itself, and keeps the requested
// ceiling from exceeding what the model can actually honor end-to-end.
// Falls back to a conservative constant when model_registry has no
// context_length for the served model (never fall through to "no limit,
// let the provider decide" again — that's exactly what produced the
// original bug).
const MAX_OUTPUT_FRACTION_OF_CONTEXT = 0.5;
const FALLBACK_CONTEXT_LENGTH = 8192;

// `model` is optional/partial so callers that haven't resolved a specific
// candidate yet (or are estimating before routing) can still get a number.
export function resolveMaxTokens(
  category: string,
  complexity: ComplexityLevel,
  model?: Pick<ModelRegistryRow, "context_length"> | null,
): number {
  const tier = tierFor(category, complexity);
  const requested = TIER_BUDGETS[tier];
  const contextLength = model?.context_length ?? FALLBACK_CONTEXT_LENGTH;
  const modelCap = Math.floor(contextLength * MAX_OUTPUT_FRACTION_OF_CONTEXT);
  return Math.max(512, Math.min(requested, modelCap));
}
