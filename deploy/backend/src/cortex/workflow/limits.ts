import type { FastifyInstance } from "fastify";
import type { PlanTier } from "../../shared-types.js";

export interface WorkflowLimits {
  maxSteps: number;
  maxCostCredits: number;
}

// Used only if the plan_limits lookup itself fails (not if the row is
// legitimately absent for some tier). maxSteps: 0 fails CLOSED rather than
// defaulting to Free's old value (3) — Free is entitled to zero workflow
// steps (see migration 0032), so any nonzero fallback here would leak
// workflow capability to Free on a transient DB error. This degrades
// safely to plain chat (orchestrator.ts's maxSteps<=0 guard), not to an
// error, so failing closed costs nothing but a temporarily-unavailable
// workflow for a Paid user during that same outage.
const FALLBACK_LIMITS: WorkflowLimits = { maxSteps: 0, maxCostCredits: 5000 };

export async function getWorkflowLimits(fastify: FastifyInstance, planTier: PlanTier): Promise<WorkflowLimits> {
  const { data, error } = await fastify.supabaseAdmin
    .from("plan_limits")
    .select("counter_type, limit_amount")
    .eq("plan_tier", planTier)
    .in("counter_type", ["workflow_steps", "workflow_cost"]);

  if (error || !data || data.length === 0) {
    fastify.log.error({ error, planTier }, "workflow limits lookup failed, using conservative fallback");
    return FALLBACK_LIMITS;
  }

  const byType = Object.fromEntries(
    data.map((row: { counter_type: string; limit_amount: number | null }) => [row.counter_type, row.limit_amount]),
  );
  return {
    maxSteps: byType.workflow_steps ?? FALLBACK_LIMITS.maxSteps,
    maxCostCredits: byType.workflow_cost ?? FALLBACK_LIMITS.maxCostCredits,
  };
}
