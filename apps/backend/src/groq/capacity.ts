import type { FastifyInstance } from "fastify";
import { GroqError } from "./client.js";

// Admission control for Groq's fallback-model daily capacity — see
// db/migrations/0056's header comment for what was verified live before
// this was designed (the key is a genuine Groq — not xAI Grok — key;
// Groq's free tier is real but organization-wide, currently 1,000
// requests/day for the openai/gpt-oss family, confirmed via a live probe
// against the actual account, not assumed from documentation alone).
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

// Same clamp rule as resolvePerUserDailyShare (openrouter/capacity.ts):
// never grant more Groq fallback attempts than the tier's own whole daily
// message entitlement already implies, and never fewer than 1.
export async function resolvePerUserDailyShareGroq(
  fastify: FastifyInstance,
  planTier: string,
): Promise<number> {
  const effectiveCapacity = Math.floor(
    fastify.config.GROQ_FREE_DAILY_CAPACITY * (1 - fastify.config.GROQ_FREE_SAFETY_BUFFER_PCT / 100),
  );
  const rawShare = Math.floor(effectiveCapacity * (fastify.config.GROQ_PER_USER_SHARE_PCT / 100));

  const { data } = await fastify.supabaseAdmin
    .from("plan_limits")
    .select("limit_amount")
    .eq("plan_tier", planTier)
    .eq("counter_type", "daily_requests")
    .maybeSingle();
  const messageEntitlement = typeof data?.limit_amount === "number" ? data.limit_amount : null;

  const clamped = messageEntitlement !== null ? Math.min(rawShare, messageEntitlement) : rawShare;
  return Math.max(1, clamped);
}

function effectiveGroqModelCapacity(fastify: FastifyInstance): number {
  return Math.max(
    1,
    Math.floor(fastify.config.GROQ_FREE_DAILY_CAPACITY * (1 - fastify.config.GROQ_FREE_SAFETY_BUFFER_PCT / 100)),
  );
}

// Called once per real Groq dispatch attempt (there is only ever one per
// turn — see groq/fallback.ts, which never retries Groq itself). Throws
// rather than returning a boolean, matching admitOpenRouterFreeRequest's
// exact reasoning: a provider_capacity_exhausted denial is thrown as a
// real GroqError(429) so it is indistinguishable from Groq's own live 429
// to isRetryableGroqError; a fair_share_exceeded denial is thrown as
// GroqFairShareExceededError, which does not match that predicate.
export async function admitGroqFallbackRequest(
  fastify: FastifyInstance,
  userId: string,
  planTier: string,
  modelId: string,
): Promise<void> {
  const perUserCap = await resolvePerUserDailyShareGroq(fastify, planTier);
  const modelCap = effectiveGroqModelCapacity(fastify);

  const { data, error } = await fastify.supabaseAdmin.rpc("admit_groq_fallback_request", {
    p_user_id: userId,
    p_model_id: modelId,
    p_per_user_daily_cap: perUserCap,
    p_model_daily_cap: modelCap,
  });

  if (error) {
    // Fail OPEN on an RPC transport error — same posture as
    // admitOpenRouterFreeRequest, for the same reason: this is a shared
    // capacity protection, not a spend-safety backstop (Groq is $0
    // regardless of admission outcome), so an outage here degrades to "no
    // extra capacity protection today", never to a billing risk.
    fastify.log.warn({ error, userId, modelId }, "admit_groq_fallback_request RPC failed, failing open");
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
// decided.
export function markGroqModelExhausted(fastify: FastifyInstance, modelId: string): void {
  const work = fastify.supabaseAdmin
    .rpc("mark_groq_model_exhausted", { p_model_id: modelId })
    .then(({ error }: { error: { message: string } | null }) => {
      if (error) fastify.log.warn({ error, modelId }, "mark_groq_model_exhausted RPC failed (non-fatal)");
    });
  if (fastify.scheduleBackground) {
    fastify.scheduleBackground(Promise.resolve(work).catch(() => {}));
  }
}
