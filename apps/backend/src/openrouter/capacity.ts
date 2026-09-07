import type { FastifyInstance } from "fastify";
import { OpenRouterError } from "./client.js";

// Admission control for OpenRouter's free-model daily capacity — see
// db/migrations/0054's header comment for the full account of what was
// verified live before this was designed (the capacity is NOT a single
// account-wide bucket shared identically by every :free model; it is
// partitioned in a way OpenRouter does not fully document).
//
// Two independent, configurable ceilings, checked and incremented together
// in one atomic Postgres call (admit_openrouter_free_request) before ANY
// real dispatch to OpenRouter:
//
//   PER-MODEL global cap   — protects the OpenRouter account.
//   PER-USER daily share   — protects users from each other (the "one user
//                            burns the whole day's capacity at midnight"
//                            scenario).
//
// A request denied by EITHER check must never reach fetch() at all — that
// is the entire point: OpenRouter's real capacity is spent by the network
// call itself, not by SPLEX's bookkeeping, so bookkeeping must run first.

export class FairShareExceededError extends Error {
  constructor() {
    super("Per-user OpenRouter free-request fair-share limit reached for today.");
    this.name = "FairShareExceededError";
  }
}

export function isFairShareExceededError(err: unknown): boolean {
  return err instanceof FairShareExceededError;
}

// Computed once per call rather than stored, so a config change (a
// wrangler var edit + redeploy) takes effect on the very next request —
// no migration, no cache to bust. Deliberately clamped to never promise
// MORE OpenRouter attempts than the plan's own daily_requests entitlement
// already implies (there is no reason to grant 60 provider attempts to a
// tier that can only ever send 100 messages a day in the first place), and
// never below 1 (a user must always get at least one real attempt).
export async function resolvePerUserDailyShare(
  fastify: FastifyInstance,
  planTier: string,
): Promise<number> {
  const effectiveCapacity = Math.floor(
    fastify.config.OPENROUTER_FREE_DAILY_CAPACITY * (1 - fastify.config.OPENROUTER_FREE_SAFETY_BUFFER_PCT / 100),
  );
  const rawShare = Math.floor(effectiveCapacity * (fastify.config.OPENROUTER_PER_USER_SHARE_PCT / 100));

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

function effectiveModelCapacity(fastify: FastifyInstance): number {
  return Math.max(
    1,
    Math.floor(fastify.config.OPENROUTER_FREE_DAILY_CAPACITY * (1 - fastify.config.OPENROUTER_FREE_SAFETY_BUFFER_PCT / 100)),
  );
}

// Every legitimate free-tier candidate in this registry carries the literal
// `:free` suffix (confirmed against the live registry audit) — checking the
// id string is sufficient and, unlike threading a ModelRegistryRow.variant
// through every call site, automatically covers every present and future
// caller of streamCompletion/completeOnce (chat, the LLM classifier, memory
// extraction, workflow planning) with no risk of a new call site forgetting
// to opt in.
export function isFreeModelId(modelId: string): boolean {
  return modelId.endsWith(":free");
}

// Called from streamCompletion/completeOnce, once per real dispatch attempt
// (including each fallback candidate within one turn — each is a genuinely
// separate OpenRouter call and must be separately admitted). Throws rather
// than returning a boolean so the two denial reasons produce genuinely
// different control flow at the call site with zero extra plumbing:
//
//   - provider_capacity_exhausted -> thrown as a real OpenRouterError(429),
//     so it is indistinguishable from OpenRouter's own 429 to every existing
//     predicate (isRetryableOpenRouterError etc.) — the fallback loop
//     already knows to try a DIFFERENT model, which is correct here since a
//     different model may well have room.
//   - fair_share_exceeded -> thrown as FairShareExceededError, which does
//     NOT match isRetryableOpenRouterError, so the fallback loop correctly
//     stops rather than retrying other models that are equally blocked by
//     this user's own per-user cap regardless of which model they target.
export async function admitOpenRouterFreeRequest(
  fastify: FastifyInstance,
  userId: string,
  planTier: string,
  modelId: string,
): Promise<void> {
  const perUserCap = await resolvePerUserDailyShare(fastify, planTier);
  const modelCap = effectiveModelCapacity(fastify);

  const { data, error } = await fastify.supabaseAdmin.rpc("admit_openrouter_free_request", {
    p_user_id: userId,
    p_model_id: modelId,
    p_per_user_daily_cap: perUserCap,
    p_model_daily_cap: modelCap,
  });

  if (error) {
    // Fail OPEN on an RPC transport error, matching this codebase's
    // existing posture for infrastructure (not spend-safety) checks — see
    // worker/rateLimit.ts's identical choice and rationale. The real
    // spend-safety backstop is that Free traffic can only ever reach a
    // $0 :free model at all (selectModelCandidates' variant filter + its
    // own redundant cost-safety guard) — an outage in THIS admission
    // layer degrades to "no extra capacity protection today", never to
    // "a Free user reaches a paid model".
    fastify.log.warn({ error, userId, modelId }, "admit_openrouter_free_request RPC failed, failing open");
    return;
  }

  if (data === "fair_share_exceeded") {
    throw new FairShareExceededError();
  }
  if (data === "provider_capacity_exhausted") {
    throw new OpenRouterError(
      "stream",
      429,
      JSON.stringify({ error: { message: "SPLEX capacity admission: provider_capacity_exhausted (no live call made)" } }),
      modelId,
    );
  }
  // data === "ok": admitted, fall through and let the caller dispatch.
}

// Layer 3 — reactive correction. Called from modelHealth.ts on seeing
// OpenRouter's OWN "free-models-per-day" 429 for a specific model, so every
// OTHER request (this user's remaining fallback candidates, and every other
// user, for THIS model only) fails fast at admitOpenRouterFreeRequest
// without a wasted network round trip, rather than waiting for the
// proactive counter to organically climb to the configured cap.
// Fire-and-forget by design (mirrors recordModelOutcome/Failure): a
// bookkeeping write must never slow or fail a request whose real answer
// (success or the honest failure message) has already been decided.
export function markModelCapacityExhausted(fastify: FastifyInstance, modelId: string): void {
  const work = fastify.supabaseAdmin
    .rpc("mark_provider_model_exhausted", { p_model_id: modelId })
    .then(({ error }: { error: { message: string } | null }) => {
      if (error) fastify.log.warn({ error, modelId }, "mark_provider_model_exhausted RPC failed (non-fatal)");
    });
  if (fastify.scheduleBackground) {
    fastify.scheduleBackground(Promise.resolve(work).catch(() => {}));
  }
}
