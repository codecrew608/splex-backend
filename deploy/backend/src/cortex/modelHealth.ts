import type { FastifyInstance } from "fastify";

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
    .then(({ error }) => {
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
