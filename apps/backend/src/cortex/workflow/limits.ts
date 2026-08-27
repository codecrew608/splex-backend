import type { FastifyInstance } from "fastify";
import type { PlanTier } from "@splex/shared-types";

export interface WorkflowLimits {
  maxSteps: number;
  maxCostCredits: number;
}

// Matches the free tier's own plan_limits values — used only if the lookup
// itself fails (not if the row is legitimately absent for some tier), so
// staying conservative here never accidentally grants more than intended.
const FALLBACK_LIMITS: WorkflowLimits = { maxSteps: 3, maxCostCredits: 5000 };

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
