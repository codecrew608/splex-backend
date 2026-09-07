import type { FastifyInstance } from "fastify";
import type { AuthedUser } from "../types/index.js";
import type { ModelRegistryRow } from "../types/index.js";
import type { ChatMessageParam, StreamCompletionResult } from "../openrouter/client.js";
import { isRetryableOpenRouterError, describeError } from "../openrouter/client.js";
import { isFairShareExceededError } from "../openrouter/capacity.js";
import { streamGroqCompletion, describeGroqError } from "./client.js";

// The ONE integration point between SPLEX's normal OpenRouter routing and
// the Groq fallback (migration 0056). Deliberately isolated in its own
// module rather than inlined into handlers/chat.ts, mirroring the same
// reasoning openrouter/capacity.ts's own separation gives: the eligibility
// rule is security/spend-relevant and belongs somewhere it can be read,
// tested, and audited as one unit — see test/groq-fallback-security.test.ts.
//
// SCOPE, stated plainly because getting this wrong is exactly the kind of
// mistake that turns an emergency valve into a second, ungoverned routing
// path:
//   - Free tier ONLY. Never Paid, never Starter — checked on user.planTier,
//     the same server-resolved, already-authenticated field every other
//     tier-gated decision in this codebase uses (see free-paid-isolation
//     test's own stated rule). There is no parameter here a caller could
//     pass to widen this.
//   - Triggers ONLY on a genuine OpenRouter capacity/rate-limit condition —
//     never on an auth failure, a malformed request, or (deliberately) a
//     402 balance-exceeded, which on a $0 :free-model dispatch signals
//     something is fundamentally wrong with the account, not "try a
//     different provider". See isOpenRouterCapacityExhausted below.
//   - Exactly ONE Groq attempt, ever, per turn. If it also fails, the
//     ORIGINAL OpenRouter error propagates — never a Groq-specific message,
//     and never a second Groq attempt. This keeps every existing,
//     already-reviewed user-facing error message (chat.ts's outer catch
//     ternary) as the single source of truth for what a user sees,
//     regardless of which provider(s) actually failed internally.
//   - Never touches model_health (recordModelOutcome/recordModelFailure):
//     those are keyed to real model_registry rows, and Groq's fallback
//     model has no such row — this is an emergency valve, not a candidate
//     in SPLEX's routing intelligence.

export function isOpenRouterCapacityExhausted(err: unknown): boolean {
  // isFairShareExceededError: SPLEX's OWN pre-emptive admission control
  // (migration 0054) denied this candidate before any network call.
  // isRetryableOpenRouterError: 429/5xx/403/404 — every shape this
  // codebase already treats as "try a different OpenRouter candidate".
  // Deliberately EXCLUDES 401 (auth — a broken key, never a capacity
  // signal) and 402 (balance-exceeded — should never happen on a $0
  // :free-model dispatch in the first place; if it does, something is
  // wrong with the account and masking it via Groq would hide a real
  // problem, not route around a routine one) and plain 4xx (malformed
  // request — would fail identically against Groq).
  return isFairShareExceededError(err) || isRetryableOpenRouterError(err);
}

export interface GroqFallbackResult {
  model: ModelRegistryRow;
  generation: StreamCompletionResult;
}

// Builds a synthetic ModelRegistryRow so every downstream call site in
// chat.ts (computeRealCost, resolveMaxTokens, updateMessageResult,
// insertCortexDecision, consumeCredits, the SSE routing summary) keeps
// working completely unchanged, regardless of which provider actually
// served the turn — no real model_registry row exists for the Groq
// fallback model, by design (see this file's header comment).
//
// variant: "free" -> computeRealCost's resolveShadowPricing prices it
// against the cheapest active PAID row, exactly like every other
// :free-tagged OpenRouter model already is — Groq-served turns still
// consume real SPLEX credits (floored at 1, same as any other free-tier
// generation), so a failover can never look like a free quota bypass in
// the ledger.
//
// context_length: a conservative, real (not invented-high) figure for the
// gpt-oss family's actual context window — used only to cap the OUTPUT
// token budget (see tokenBudget.ts's MAX_OUTPUT_FRACTION_OF_CONTEXT), so
// erring low here only means a smaller max_tokens request, never a broken
// one.
function buildGroqModel(fastify: FastifyInstance, category: string): ModelRegistryRow {
  return {
    id: "groq-fallback", // synthetic — never passed to recordModelOutcome/Failure
    category,
    openrouter_model_id: fastify.config.GROQ_FALLBACK_MODEL,
    variant: "free",
    capability_score: 0,
    context_length: 32768,
    cost_per_million_input: 0,
    cost_per_million_output: 0,
    is_active: true,
    priority: 0,
  };
}

export interface AttemptGroqFallbackOptions {
  fastify: FastifyInstance;
  triggeringError: unknown;
  user: AuthedUser;
  category: string;
  messages: ChatMessageParam[];
  maxTokens: number;
  signal?: AbortSignal;
  onToken: (delta: string) => void;
}

// Returns null (never throws its OWN error) whenever the fallback should
// not or could not serve this turn — the caller's contract is always
// "on null, rethrow the ORIGINAL OpenRouter error", so every existing,
// audited error-message path stays authoritative.
export async function attemptGroqFallback(opts: AttemptGroqFallbackOptions): Promise<GroqFallbackResult | null> {
  const { fastify, triggeringError, user, category, messages, maxTokens, signal, onToken } = opts;

  if (user.planTier !== "free") return null;
  if (!fastify.config.GROQ_API_KEY) return null;
  if (!isOpenRouterCapacityExhausted(triggeringError)) return null;

  const model = buildGroqModel(fastify, category);

  try {
    const generation = await streamGroqCompletion({
      fastify, model: model.openrouter_model_id, messages, signal, onToken, maxTokens,
      userId: user.id, planTier: user.planTier,
    });
    fastify.log.info(
      { userId: user.id, category, originalError: describeError(triggeringError) },
      "OpenRouter capacity exhausted for this Free-tier turn — served via fallback provider",
    );
    return { model, generation };
  } catch (fallbackErr) {
    fastify.log.warn(
      { userId: user.id, category, fallbackError: describeGroqError(fallbackErr) },
      "fallback provider also unavailable — surfacing the original OpenRouter error to the user",
    );
    return null;
  }
}
