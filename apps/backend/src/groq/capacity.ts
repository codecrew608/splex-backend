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
  const paidSlice = Math.floor(bufferedTotal * (fastify.config.GROQ_PAID_SHARE_PCT / 100));
  const modelDailyCap = Math.max(1, isPaid ? paidSlice : bufferedTotal - paidSlice);

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

// Reactive correction — mirrors markModelCapacityExhausted exactly,
// applied to the Groq table instead. Fire-and-forget: a bookkeeping write
// must never slow or fail a request whose real answer has already been
// decided. Marks BOTH tiers' bookkeeping rows exhausted — a live 429 from
// Groq means the real, physical, shared account is out of room right now,
// which is true regardless of which tier's slice happened to trigger it.
export function markGroqModelExhausted(fastify: FastifyInstance, planTier: PlanTier, modelId: string): void {
  const isPaid = planTier !== "free";
  const bookkeepingIds = [`${modelId}#free-tier`, `${modelId}#paid-tier`];
  for (const id of bookkeepingIds) {
    const work = fastify.supabaseAdmin
      .rpc("mark_groq_model_exhausted", { p_model_id: id })
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) fastify.log.warn({ error, modelId: id, planTier, isPaid }, "mark_groq_model_exhausted RPC failed (non-fatal)");
      });
    if (fastify.scheduleBackground) {
      fastify.scheduleBackground(Promise.resolve(work).catch(() => {}));
    }
  }
}
