import type { FastifyInstance } from "fastify";
import { isBalanceExceededError, isModelUnavailableError } from "../openrouter/client.js";

export type ModelOutcome = "success" | "failure" | "timeout";

// Records one observation against a model's rolling health window (see
// migration 0014's record_model_health). Deliberately fire-and-forget:
// telemetry must never fail, slow, or block a user-facing generation that
// already succeeded, so this swallows its own errors and is called without
// await at every call site.
export function recordModelOutcome(
  fastify: FastifyInstance,
  modelId: string,
  outcome: ModelOutcome,
  latencyMs?: number,
  costUsd = 0,
): void {
  void fastify.supabaseAdmin
    .rpc("record_model_health", {
      p_model_id: modelId,
      p_outcome: outcome,
      p_latency_ms: latencyMs ?? null,
      p_cost_usd: costUsd,
    })
    .then(({ error }: { error: { message: string } | null }) => {
      if (error) fastify.log.warn({ error, modelId, outcome }, "record_model_health failed (non-fatal)");
    });
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
): void {
  if (isBalanceExceededError(err)) {
    fastify.log.warn({ modelId }, "OpenRouter balance exceeded — not counting against model health");
    return;
  }
  if (isModelUnavailableError(err)) {
    // Not a health signal either — the model is GONE, not unhealthy, and
    // scoring it down would be pointless when it can never succeed again.
    // Retire it instead so the next request never selects it.
    void deactivateUnavailableModel(fastify, modelId, err);
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
  void fastify.supabaseAdmin
    .from("model_registry")
    .update({ is_active: false })
    .eq("id", modelId)
    .then(({ error }: { error: { message: string } | null }) => {
      if (error) fastify.log.warn({ error, modelId }, "failed to deactivate unavailable model (non-fatal)");
    });
}
