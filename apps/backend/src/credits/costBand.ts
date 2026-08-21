import type { FastifyInstance } from "fastify";
import type { ComplexityLevel, PlanTier } from "@splex/shared-types";

// Pre-flight gate estimate only — NOT what actually gets charged. credit_cost_bands
// stores a PERCENTAGE of the caller's own plan's monthly total, not an absolute
// number, specifically so every tier can always afford several complex-classified
// requests from a fresh pool regardless of how big that pool is. The real charge
// (computed after generation, from real token usage) lives in realCost.ts and can
// come out lower or higher than this estimate.
export async function resolveCreditGateEstimate(
  fastify: FastifyInstance,
  complexity: ComplexityLevel,
  planTier: PlanTier,
): Promise<number> {
  const [bandResult, limitResult] = await Promise.all([
    fastify.supabaseAdmin.from("credit_cost_bands").select("min_percent").eq("complexity", complexity).single(),
    fastify.supabaseAdmin
      .from("plan_limits")
      .select("limit_amount")
      .eq("plan_tier", planTier)
      .eq("counter_type", "credits")
      .single(),
  ]);

  if (bandResult.error || !bandResult.data || limitResult.error || !limitResult.data) {
    fastify.log.error(
      { bandError: bandResult.error, limitError: limitResult.error, complexity, planTier },
      "credit gate estimate lookup failed, defaulting to a conservative flat estimate",
    );
    return 50;
  }

  const planTotal = limitResult.data.limit_amount as number;
  const minPercent = bandResult.data.min_percent as number;
  return Math.max(1, Math.ceil((planTotal * minPercent) / 100));
}

// Same min_percent-of-a-band lookup as resolveCreditGateEstimate, but
// applied against a caller-supplied base rather than the plan's whole
// monthly pool — for estimating one step's worst-case share of a
// *per-workflow* ceiling, not one message's worst-case share of a whole
// month. Reusing resolveCreditGateEstimate's pool-relative number here
// instead (as the workflow orchestrator originally did) meant every
// estimate was sized in the hundred-thousands (10-15% of a 1M-credit Pro
// pool) while being compared against a workflow_cost ceiling in the tens
// of thousands — structurally guaranteeing every multi-step workflow
// would be rejected regardless of its real cost, confirmed live: the
// spec's own canonical "build me a landing page" example failed this
// check on every attempt. workflow_cost is what this is actually being
// measured against, so it's what the percentage should be taken of.
export async function resolveWorkflowStepEstimate(
  fastify: FastifyInstance,
  complexity: ComplexityLevel,
  workflowCostCeiling: number,
): Promise<number> {
  const { data, error } = await fastify.supabaseAdmin.from("credit_cost_bands").select("min_percent").eq("complexity", complexity).single();

  if (error || !data) {
    fastify.log.error({ error, complexity }, "credit band lookup failed for workflow step estimate, defaulting to a conservative flat estimate");
    return 50;
  }

  const minPercent = data.min_percent as number;
  return Math.max(1, Math.ceil((workflowCostCeiling * minPercent) / 100));
}
