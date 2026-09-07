import type { FastifyInstance } from "fastify";
import type { PlanTier } from "@splex/shared-types";
import { GroqError } from "./client.js";

// Admission control for Groq's fallback-model daily capacity — see
// db/migrations/0056's header comment for what was verified live before
// this was designed (the key is a genuine Groq — not xAI Grok — key;
// Groq's free tier is real but organization-wide, currently 1,000
// requests/day for the openai/gpt-oss family, confirmed via a live probe
// against the actual account, not assumed from documentation alone).
//
// EXTENDED to serve BOTH tiers (previously Free-only) at the user's
// explicit direction: Paid dispatch failures today are almost entirely 402
// balance-exceeded (the OpenRouter account holds $0 purchased credit, by
// the user's own stated choice, indefinitely) — so without this, every
// single Paid request fails outright until real balance is added. Routing
// Paid through the same $0, rate-limited Groq account as an interim path
// means Paid genuinely WORKS today, and the moment real OpenRouter balance
// lands, OpenRouter succeeds on the first attempt and this path is simply
// never reached again — zero further code changes needed on that day.
//
// Free and Paid are bookkept as two INDEPENDENT slices of the one real
// shared Groq account limit (never simply summed from two independently
// configured caps — that would risk quietly exceeding the real ceiling).
// See resolveTierBudget below for the derivation.
//
// Deliberately mirrors openrouter/capacity.ts's exact two-layer shape
// (proactive per-model + per-user daily counters, checked atomically
// before any real dispatch; reactive correction on a live 429) rather than
// inventing a second admission pattern — see that file for the fuller
// design rationale, which applies unchanged here.

export class GroqFairShareExceededError extends Error {
  constructor() {
    super("Per-user Groq fallback fair-share limit reached for today.");
    this.name = "GroqFairShareExceededError";
  }
}

export function isGroqFairShareExceededError(err: unknown): boolean {
  return err instanceof GroqFairShareExceededError;
}

interface TierBudget {
  // The bookkeeping key passed as p_model_id to admit_groq_fallback_request
  // — NOT the real model sent to Groq's API (that's always
  // GROQ_FALLBACK_MODEL). Tier-qualified so provider_groq_capacity tracks
  // Free and Paid as two separate rows against the one real physical
  // account, even though both real dispatches hit the identical Groq
  // model/endpoint. This is what makes "Paid can never be starved by a
  // Free traffic spike, and vice versa" a real, enforced guarantee rather
  // than a hope.
  bookkeepingModelId: string;
  modelDailyCap: number;
  perUserDailyCap: number;
}

// Splits ONE real, shared Groq daily ceiling into two independent tier
// budgets that can never together exceed it — deriving both from the same
// total rather than configuring them separately, which is what would let
// them silently sum past the real account limit.
//
// Defaults (all explicitly policy choices, not measured facts, exactly
// like OPENROUTER_PER_USER_SHARE_PCT's own doc comment says of itself):
//   GROQ_TOTAL_DAILY_CAPACITY   1000  — verified live account limit
//   GROQ_SAFETY_BUFFER_PCT      20%   — buffered total: 800/day
//   GROQ_PAID_SHARE_PCT         35%   — Paid's slice: ~280/day
//   (Free gets the remaining 65%: ~520/day)
//   GROQ_PER_USER_SHARE_PCT        5% (of Free's slice) — many Free users
//   GROQ_PER_USER_SHARE_PCT_PAID  25% (of Paid's slice) — far fewer Paid
//     users expected, and losing service for a paying customer costs more,
//     so each one is guaranteed a much larger individual share.
export async function resolveTierBudget(fastify: FastifyInstance, planTier: PlanTier): Promise<TierBudget> {
  const bufferedTotal = Math.max(
    1,
    Math.floor(fastify.config.GROQ_TOTAL_DAILY_CAPACITY * (1 - fastify.config.GROQ_SAFETY_BUFFER_PCT / 100)),
  );
  const isPaid = planTier !== "free";

  // paidSlice is clamped into [1, bufferedTotal - 1] BEFORE freeSlice is
  // derived as its exact complement — not floored to >=1 independently on
  // each branch AFTER an independent split, which is a subtly different
  // (and subtly broken) computation this function shipped with initially:
  // at GROQ_PAID_SHARE_PCT=0, rawPaidSlice is legitimately 0, so a
  // per-branch `Math.max(1, paidSlice)` floors PAID's cap to 1 while
  // FREE's cap had already been set to the full bufferedTotal (computed
  // from the un-floored paidSlice=0) — summing to bufferedTotal + 1, one
  // request/day over the real account limit. Symmetrically broken at
  // GROQ_PAID_SHARE_PCT=100. Clamping paidSlice FIRST, into both bounds at
  // once, then deriving freeSlice as bufferedTotal - paidSlice, makes the
  // complement relationship exact by construction: for any bufferedTotal
  // >= 2 and any GROQ_PAID_SHARE_PCT in the schema's allowed [0, 100]
  // range, paidSlice and freeSlice are BOTH guaranteed in [1, bufferedTotal
  // - 1], and their sum is always exactly bufferedTotal — never over,
  // never leaving either tier at 0. (bufferedTotal < 2 is a genuinely
  // degenerate single-or-zero-slot config no real deployment would run;
  // there, the only invariant that actually matters — never exceed the
  // real account limit — still holds, even if one tier gets 0 that call.)
  const rawPaidSlice = Math.floor(bufferedTotal * (fastify.config.GROQ_PAID_SHARE_PCT / 100));
  const paidSlice =
    bufferedTotal >= 2 ? Math.min(Math.max(rawPaidSlice, 1), bufferedTotal - 1) : Math.min(rawPaidSlice, bufferedTotal);
  const freeSlice = bufferedTotal - paidSlice;
  const modelDailyCap = isPaid ? paidSlice : freeSlice;

  const perUserSharePct = isPaid ? fastify.config.GROQ_PER_USER_SHARE_PCT_PAID : fastify.config.GROQ_PER_USER_SHARE_PCT;
  const rawShare = Math.floor(modelDailyCap * (perUserSharePct / 100));

  // Same clamp rule as resolvePerUserDailyShare (openrouter/capacity.ts):
  // never grant more Groq fallback attempts than the tier's own whole daily
  // message entitlement already implies.
  const { data } = await fastify.supabaseAdmin
    .from("plan_limits")
    .select("limit_amount")
    .eq("plan_tier", planTier)
    .eq("counter_type", "daily_requests")
    .maybeSingle();
  const messageEntitlement = typeof data?.limit_amount === "number" ? data.limit_amount : null;
  const perUserDailyCap = Math.max(1, messageEntitlement !== null ? Math.min(rawShare, messageEntitlement) : rawShare);

  return {
    bookkeepingModelId: `${fastify.config.GROQ_FALLBACK_MODEL}#${isPaid ? "paid" : "free"}-tier`,
    modelDailyCap,
    perUserDailyCap,
  };
}

// Called once per real Groq dispatch attempt (there is only ever one per
// turn — see groq/fallback.ts, which never retries Groq itself). Throws
// rather than returning a boolean, matching admitOpenRouterFreeRequest's
// exact reasoning: a provider_capacity_exhausted denial is thrown as a
// real GroqError(429) so it is indistinguishable from Groq's own live 429
// to isRetryableGroqError; a fair_share_exceeded denial is thrown as
// GroqFairShareExceededError, which does not match that predicate.
//
// modelId here is the REAL id sent to Groq's API — used for the actual
// dispatch, not for admission bookkeeping (see TierBudget's own comment
// for why those are deliberately different keys).
export async function admitGroqFallbackRequest(
  fastify: FastifyInstance,
  userId: string,
  planTier: PlanTier,
  modelId: string,
): Promise<void> {
  const budget = await resolveTierBudget(fastify, planTier);

  const { data, error } = await fastify.supabaseAdmin.rpc("admit_groq_fallback_request", {
    p_user_id: userId,
    p_model_id: budget.bookkeepingModelId,
    p_per_user_daily_cap: budget.perUserDailyCap,
    p_model_daily_cap: budget.modelDailyCap,
  });

  if (error) {
    // Fail OPEN on an RPC transport error — same posture as
    // admitOpenRouterFreeRequest, for the same reason: this is a shared
    // capacity protection, not a spend-safety backstop (Groq is $0
    // regardless of admission outcome), so an outage here degrades to "no
    // extra capacity protection today", never to a billing risk.
    fastify.log.warn({ error, userId, modelId, planTier }, "admit_groq_fallback_request RPC failed, failing open");
    return;
  }

  if (data === "fair_share_exceeded") {
    throw new GroqFairShareExceededError();
  }
  if (data === "provider_capacity_exhausted") {
    throw new GroqError(429, JSON.stringify({ error: { message: "SPLEX capacity admission: provider_capacity_exhausted (no live call made)" } }), modelId);
  }
}

// REMOVED (2026-09-07, same day it shipped) — there is deliberately no
// reactive "mark Groq exhausted for the day" here any more.
//
// WHAT IT DID, AND WHY IT WAS WRONG. It mirrored OpenRouter's
// markModelCapacityExhausted: on a live 429, mark the model exhausted for
// the whole UTC day so later requests fail fast instead of re-discovering
// it. That is correct for OpenRouter, whose 429 genuinely means
// "free-models-per-day spent" (verified: its reset header points at UTC
// midnight). It is factually wrong for Groq, and copying the pattern
// across without re-checking the premise is exactly the mistake:
//
//   Groq's own response headers, measured directly against this account:
//     x-ratelimit-limit-requests: 1000   reset: 1m26.4s
//     x-ratelimit-limit-tokens:   8000   reset: 577ms
//
// Those are ROLLING SUB-MINUTE windows, not daily caps. A Groq 429 means
// "slow down for a few seconds", not "come back tomorrow".
//
// REAL PRODUCTION IMPACT, observed the same day: one Free user asked for a
// full e-commerce site. That single large generation exceeded the 8,000
// tokens-per-minute window and returned a 429 that would have cleared in
// under a second. This function then wrote used=1000000 against BOTH tier
// bookkeeping rows — disabling the Groq fallback for EVERY user, on BOTH
// tiers, until UTC midnight. The user had spent 5 of 50 messages and 103
// of 3,000 daily credits, and was locked out with "You've reached today's
// limit for instant replies."
//
// The cross-tier marking made it worse and was wrong on its own terms: it
// broke the "Free and Paid can never starve each other" guarantee that the
// tier-split bookkeeping exists to provide, from the one code path that
// bypassed it.
//
// WHY NOTHING REPLACES IT. Groq already enforces its own limits, returns a
// clean immediate 429 (no generation is wasted), and clears within seconds.
// SPLEX re-implementing that with a coarser, longer-lived, global kill
// switch can only ever be worse than deferring to the provider. A failed
// attempt already degrades correctly through attemptGroqFallback -> the
// original OpenRouter error -> the existing honest user-facing message, and
// the next request simply succeeds. The proactive per-user/per-model
// counters above stay: those are a SPLEX fairness policy, not an attempt to
// mirror Groq's rate limiter.
