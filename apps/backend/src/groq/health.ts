import type { FastifyInstance } from "fastify";
import type { PlanTier } from "@splex/shared-types";

// Groq dispatch outcome tracking (migration 0058) — reliability, not
// capacity. provider_groq_capacity (migration 0056) answers "are we near
// our OWN configured ceiling"; this answers "is Groq ITSELF getting less
// reliable" — a genuinely different question, and the concrete, buildable
// mitigation for the fact that Groq's free developer tier carries no
// contract or SLA (see db/migrations/0056's header for how that was
// verified): code cannot make an unguaranteed dependency guaranteed, but it
// can make sure a real degradation is caught from a log/dashboard, not from
// users complaining first.
//
// Fire-and-forget, matching every other bookkeeping write in this codebase
// (recordModelOutcome, markModelCapacityExhausted, markGroqModelExhausted)
// — telemetry must never fail or slow a request whose real answer has
// already been decided.

function normalizeTier(planTier: PlanTier): "free" | "paid" {
  return planTier === "free" ? "free" : "paid";
}

export function recordGroqDispatchSuccess(fastify: FastifyInstance, planTier: PlanTier): void {
  const work = fastify.supabaseAdmin
    .rpc("record_groq_dispatch_outcome", { p_tier: normalizeTier(planTier), p_success: true })
    .then(({ error }: { error: { message: string } | null }) => {
      if (error) fastify.log.warn({ error, planTier }, "record_groq_dispatch_outcome (success) RPC failed (non-fatal)");
    });
  if (fastify.scheduleBackground) {
    fastify.scheduleBackground(Promise.resolve(work).catch(() => {}));
  }
}

export function recordGroqDispatchFailure(fastify: FastifyInstance, planTier: PlanTier, status: number, body: string): void {
  const work = fastify.supabaseAdmin
    .rpc("record_groq_dispatch_outcome", {
      p_tier: normalizeTier(planTier),
      p_success: false,
      p_status: status,
      p_body: body.slice(0, 500),
    })
    .then(({ error }: { error: { message: string } | null }) => {
      if (error) fastify.log.warn({ error, planTier, status }, "record_groq_dispatch_outcome (failure) RPC failed (non-fatal)");
    });
  if (fastify.scheduleBackground) {
    fastify.scheduleBackground(Promise.resolve(work).catch(() => {}));
  }
}
