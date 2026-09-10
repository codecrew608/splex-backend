import type { FastifyInstance } from "fastify";
import { isBalanceExceededError, isModelUnavailableError, isFreeModelDailyCapExceededError, isAuthError, OpenRouterError } from "../openrouter/client.js";
import { markModelCapacityExhausted, isFairShareExceededError } from "../openrouter/capacity.js";
import { recordOpenRouterCredentialSuccess, recordOpenRouterCredentialFailure } from "../openrouter/health.js";

export type ModelOutcome = "success" | "failure" | "timeout";

// Records one observation against a model's rolling health window (see
// migration 0014's record_model_health). Deliberately fire-and-forget:
// telemetry must never fail, slow, or block a user-facing generation that
// already succeeded, so this swallows its own errors and is called without
// await at every call site.
// Hands fire-and-forget bookkeeping to the runtime's background scheduler
// when there is one.
//
// On Workers a bare `void promise` is abandoned the moment the isolate is
// torn down — the same mechanism that silently prevented every memory
// extraction from ever landing. These writes are small, but "small" is not
// "instant", and a health record or a model deactivation that never commits
// is a routing decision made on stale data. On Node there is no scheduler
// and none is needed: the process outlives the response.
function runBackground(fastify: FastifyInstance, work: PromiseLike<unknown>): void {
  // Supabase query builders are thenable but not full Promises, so wrap
  // before attaching handlers.
  const scheduled = Promise.resolve(work).catch((err: unknown) => {
    fastify.log.warn({ err }, "background bookkeeping failed (non-fatal)");
  });
  if (fastify.scheduleBackground) {
    fastify.scheduleBackground(scheduled);
    return;
  }
  void scheduled;
}

export function recordModelOutcome(
  fastify: FastifyInstance,
  modelId: string,
  outcome: ModelOutcome,
  latencyMs?: number,
  costUsd = 0,
): void {
  // G5: a successful model dispatch is also proof the API 1 credential is
  // currently working — stamp last_success_at on openrouter_credential_health
  // so "the key recovered" is observable. Never gated on tier/variant: a
  // success on ANY OpenRouter model (Free :free, Starter paid, media) went
  // through the same OPENROUTER_API_KEY.
  if (outcome === "success") {
    recordOpenRouterCredentialSuccess(fastify);
  }
  runBackground(
    fastify,
    fastify.supabaseAdmin.rpc("record_model_health", {
      p_model_id: modelId,
      p_outcome: outcome,
      p_latency_ms: latencyMs ?? null,
      p_cost_usd: costUsd,
    }).then(({ error }: { error: { message: string } | null }) => {
      if (error) fastify.log.warn({ error, modelId, outcome }, "record_model_health failed (non-fatal)");
    }),
  );
}

// An aborted/timed-out fetch surfaces as one of these — distinguishing
// them from a genuine provider error matters for routing, since a timeout
// says something different about a model than a 400 does.
export function classifyFailure(err: unknown): ModelOutcome {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "timeout";
  return "failure";
}

// Records a failed attempt against a model — EXCEPT when the failure was a
// 402 from OpenRouter, which is an account-level billing condition and says
// nothing whatsoever about the model that happened to be tried at the time.
//
// This is why topping up OpenRouter credit didn't restore normal service
// immediately. While the account sat at zero balance every attempt 402'd,
// and each one was recorded as that model's failure — across every model
// the fallback loop reached. reliabilityFor() (cortex/routing.ts) then
// blends those counts into the routing score, and the health window only
// rolls after an hour, so even once credit was added routing kept steering
// away from perfectly healthy models until the bad window aged out. A
// billing state must never be laundered into model-quality data.
export function recordModelFailure(
  fastify: FastifyInstance,
  modelId: string,
  err: unknown,
  latencyMs?: number,
  // The OpenRouter STRING id (e.g. "vendor/model:free") — distinct from
  // `modelId` above, which is the model_registry ROW's uuid (what
  // record_model_health/model_registry updates key on). markModelCapacityExhausted
  // needs the string id: it writes into provider_free_model_capacity, which
  // is keyed the same way admitOpenRouterFreeRequest reads it — by the
  // literal id OpenRouter itself understands, not SPLEX's internal row id.
  // Optional so every EXISTING call site keeps compiling unchanged; only
  // the isFreeModelDailyCapExceededError branch below actually needs it,
  // and that branch degrades to a log-only warning if it is omitted rather
  // than writing a row keyed on the wrong identifier — which is exactly
  // the live bug this parameter exists to prevent (verified in
  // production, 2026-09-07: two rows were written keyed on a
  // model_registry uuid, which admitOpenRouterFreeRequest can never match
  // against, silently defeating the reactive layer).
  openrouterModelId?: string,
): void {
  if (isAuthError(err)) {
    // G2: an OpenRouter auth/credential failure (rejected or disabled key,
    // account not authorized). Same principle as the balance branch below:
    // every model sits behind the same credential, so this says nothing
    // about THIS model's quality and must not be recorded against its
    // routing health. Retrying is pointless (the loop's own
    // isRetryableOpenRouterError already excludes 401, so it doesn't).
    // What this DOES do: emit a distinct, loud, structured observability
    // signal, and stamp openrouter_credential_health so a dashboard/log
    // can see the API 1 key is the thing that broke and when it last
    // worked. NOT a Groq-fallback trigger — an auth misconfiguration is an
    // ops condition, not a capacity condition (see groq/fallback.ts).
    const status = err instanceof OpenRouterError ? err.status : 401;
    fastify.log.error(
      { modelId, openrouterModelId, status, credential: "api1" },
      "OPENROUTER CREDENTIAL REJECTED (API 1) — check OPENROUTER_API_KEY; not counting against model health, not falling back to Groq",
    );
    recordOpenRouterCredentialFailure(fastify, status, "auth");
    return;
  }
  if (isBalanceExceededError(err)) {
    fastify.log.warn({ modelId }, "OpenRouter balance exceeded — not counting against model health");
    return;
  }
  if (isFairShareExceededError(err)) {
    // A PER-USER policy limit (migration 0054), unrelated to this model's
    // own behaviour entirely — the same request would have been rejected
    // identically whichever model it targeted. Recording it as a failure
    // would penalise a model for a different user's usage pattern.
    fastify.log.warn({ modelId }, "per-user fair-share limit hit — not counting against model health");
    return;
  }
  if (isFreeModelDailyCapExceededError(err)) {
    // Same principle as the balance-exceeded branch above, applied to a
    // different account-level condition: this model hit its tracked daily
    // free-request ceiling (migration 0054), which says nothing about its
    // own quality or uptime and must not count against it — and unlike
    // isModelUnavailableError below, it is NOT permanently dead, so it must
    // not be deactivated either. It will have room again at UTC midnight.
    //
    // The one thing this DOES do: mark the model's own capacity counter
    // exhausted right now, so every other pending/future attempt at this
    // specific model today short-circuits at admitOpenRouterFreeRequest
    // without spending a network round trip re-discovering what this
    // response just told us directly.
    fastify.log.warn({ modelId, openrouterModelId }, "OpenRouter free-model daily capacity hit — not counting against model health");
    if (openrouterModelId) {
      markModelCapacityExhausted(fastify, openrouterModelId);
    } else {
      fastify.log.warn({ modelId }, "recordModelFailure: no openrouterModelId supplied, cannot mark provider capacity exhausted for this call site");
    }
    return;
  }
  if (isModelUnavailableError(err)) {
    // Not a health signal either — the model is GONE, not unhealthy, and
    // scoring it down would be pointless when it can never succeed again.
    // Retire it instead so the next request never selects it.
    deactivateUnavailableModel(fastify, modelId, err);
    return;
  }
  recordModelOutcome(fastify, modelId, classifyFailure(err), latencyMs);
}

// Self-healing for the stale-registry-row class of failure: when OpenRouter
// says a model no longer exists, flip is_active=false so selectModelCandidates
// stops offering it. Turns "this row breaks routing until a human notices"
// into "this row costs exactly one degraded request, once".
//
// Deliberately conservative about what triggers it — only the unambiguous
// 404/"No endpoints found" signal, never a 429 or 5xx, because a busy or
// briefly-down model must NOT be permanently retired from the registry.
//
// Fire-and-forget, matching recordModelOutcome: a bookkeeping write must
// never fail or slow a user-facing request that is already in its error
// path. Flipping is_active is also fully reversible — the row, its scores
// and its curated priority all survive, so re-enabling a model that comes
// back is a one-column update, not a re-import.
function deactivateUnavailableModel(fastify: FastifyInstance, modelId: string, err: unknown): void {
  fastify.log.error(
    { modelId, errorMessage: err instanceof Error ? err.message : String(err) },
    "model unavailable upstream — deactivating registry row so routing stops selecting it",
  );
  runBackground(
    fastify,
    fastify.supabaseAdmin
      .from("model_registry")
      .update({ is_active: false })
      .eq("id", modelId)
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) fastify.log.warn({ error, modelId }, "failed to deactivate unavailable model (non-fatal)");
      }),
  );
}
