import type { FastifyInstance } from "fastify";
import type { AuthedUser } from "../types/index.js";
import type { ModelRegistryRow } from "../types/index.js";
import type { ChatMessageParam, StreamCompletionResult } from "../openrouter/client.js";
import { isRetryableOpenRouterError, isBalanceExceededError, describeError } from "../openrouter/client.js";
import { isFairShareExceededError } from "../openrouter/capacity.js";
import { streamGroqCompletion, describeGroqError } from "./client.js";

// The ONE integration point between SPLEX's normal OpenRouter routing and
// the Groq fallback (migration 0056). Deliberately isolated in its own
// module rather than inlined into handlers/chat.ts, mirroring the same
// reasoning openrouter/capacity.ts's own separation gives: the eligibility
// rule is security/spend-relevant and belongs somewhere it can be read,
// tested, and audited as one unit — see test/groq-fallback-security.test.ts.
//
// EXTENDED TO PAID (explicit user decision, 2026-09-07): originally Free
// tier only. Paid dispatch failures today are almost entirely 402
// balance-exceeded — the OpenRouter account holds $0 purchased credit, by
// the user's own stated, indefinite choice — so without this, every single
// Paid request failed outright. Serving Paid through the same $0,
// rate-limited Groq account as an interim path means Paid genuinely works
// TODAY, and the moment real OpenRouter balance is added, OpenRouter
// succeeds on the first attempt and this path is simply never reached
// again for Paid — zero further code changes needed on that day. See
// groq/capacity.ts's resolveTierBudget for how Free and Paid get
// independently-bookkept slices of the one real shared Groq limit, so
// neither tier can ever starve the other's allocation.
//
// SCOPE, stated plainly because getting this wrong is exactly the kind of
// mistake that turns an emergency valve into a second, ungoverned routing
// path:
//   - Every real caller (Free or Paid) is checked on user.planTier, the
//     same server-resolved, already-authenticated field every other
//     tier-gated decision in this codebase uses — there is no parameter
//     here a caller could pass to spoof it.
//   - The TRIGGER CONDITION differs deliberately by tier (isEligibleFailure
//     below): Free never falls back on a 402 (on a $0 :free model that
//     should never happen, and would signal something is actually broken,
//     not routine exhaustion — masking it via Groq would hide a real
//     problem). Paid DOES fall back on 402 — for Paid, "the account has no
//     money" is not a broken-request signal, it is THE expected, routine
//     failure mode today, and exactly the condition this extension exists
//     to cover. Neither tier ever falls back on 401 (auth) or a plain 4xx
//     (malformed request) — those would fail identically against Groq.
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
//   - Never touches billing: a Groq-served Paid turn still runs through
//     the SAME computeRealCost/consumeCredits path as any OpenRouter-served
//     turn (see buildGroqModel's own comment) — Paid users are still
//     charged their normal SPLEX credits for the turn, exactly as if
//     OpenRouter had served it. Groq's own $0 real cost to SPLEX is
//     invisible to that accounting, by design — it is not a discount.

// Free: never on 402 (see header comment). Paid: 402 IS the expected,
// routine trigger today.
export function isOpenRouterCapacityExhausted(err: unknown): boolean {
  return isFairShareExceededError(err) || isRetryableOpenRouterError(err);
}

function isEligibleFailure(err: unknown, planTier: string): boolean {
  if (isOpenRouterCapacityExhausted(err)) return true;
  return planTier !== "free" && isBalanceExceededError(err);
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
// variant is tier-derived, matching queryModelRegistry's own convention
// (free tier -> 'free' variant, everyone else -> 'paid') — this is what
// makes computeRealCost charge a Paid turn its REAL configured cost
// (resolveShadowPricing's `variant === "paid"` branch, using this row's
// own cost_per_million_input/output) rather than the Free shadow-pricing
// path. A Groq-served Paid turn must cost the user the same SPLEX credits
// a real paid dispatch would have — Groq's own $0 cost to SPLEX must never
// leak into what the USER is charged, or Paid users would learn that
// hitting Groq is cheaper than hitting OpenRouter, which is a real
// incentive-alignment bug waiting to happen. cost_per_million figures below
// are deliberately set to a representative mid-tier PAID rate (matching
// this registry's own general-category workhorse pricing), not $0.
//
// context_length: a conservative, real (not invented-high) figure for the
// gpt-oss family's actual context window — used only to cap the OUTPUT
// token budget (see tokenBudget.ts's MAX_OUTPUT_FRACTION_OF_CONTEXT), so
// erring low here only means a smaller max_tokens request, never a broken
// one.
function buildGroqModel(fastify: FastifyInstance, category: string, planTier: string): ModelRegistryRow {
  const isPaid = planTier !== "free";
  return {
    id: "groq-fallback", // synthetic — never passed to recordModelOutcome/Failure
    category,
    openrouter_model_id: fastify.config.GROQ_FALLBACK_MODEL,
    variant: isPaid ? "paid" : "free",
    capability_score: 0,
    context_length: 32768,
    // Representative mid-tier paid rate (matches this registry's own
    // general-category deepseek-v4-flash-class pricing) — charged to Paid
    // users exactly as a real OpenRouter paid dispatch would be. 0 for
    // Free, matching every other :free-variant row (shadow-priced instead,
    // same as any other free-tier generation).
    cost_per_million_input: isPaid ? 0.5 : 0,
    cost_per_million_output: isPaid ? 2.0 : 0,
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

  if (!fastify.config.GROQ_API_KEY) return null;
  if (!isEligibleFailure(triggeringError, user.planTier)) return null;

  const model = buildGroqModel(fastify, category, user.planTier);

  try {
    const generation = await streamGroqCompletion({
      fastify, model: model.openrouter_model_id, messages, signal, onToken, maxTokens,
      userId: user.id, planTier: user.planTier,
    });
    fastify.log.info(
      { userId: user.id, planTier: user.planTier, category, originalError: describeError(triggeringError) },
      "OpenRouter unavailable for this turn — served via fallback provider",
    );
    return { model, generation };
  } catch (fallbackErr) {
    fastify.log.warn(
      { userId: user.id, planTier: user.planTier, category, fallbackError: describeGroqError(fallbackErr) },
      "fallback provider also unavailable — surfacing the original OpenRouter error to the user",
    );
    return null;
  }
}
