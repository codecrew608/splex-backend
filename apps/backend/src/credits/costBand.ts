import type { FastifyInstance } from "fastify";
import type { ComplexityLevel, PlanTier } from "@splex/shared-types";

// Pre-flight gate estimate only — NOT what actually gets charged. credit_cost_bands
// stores a PERCENTAGE of the caller's own plan's monthly total, not an absolute
// number, specifically so every tier can always afford several complex-classified
// requests from a fresh pool regardless of how big that pool is. The real charge
// (computed after generation, from real token usage) lives in realCost.ts and can
// come out lower or higher than this estimate.
//
// checkCredits() (unless called with monthlyOnly) checks this SAME number against
// BOTH the monthly pool AND the daily pool (migration 0018) — but a percentage of
// the monthly total can structurally exceed the much smaller daily pool regardless
// of actual usage. Confirmed live: Pro's complex-band estimate is 10% of a 15,000
// monthly pool = 1,500, while Pro's entire daily pool is only 750 — every single
// "complex"-classified request (including every Agent Workflow step, which is
// always gated at the complex band — see workflow/orchestrator.ts's
// STEP_COMPLEXITY) failed the daily check outright, even on a completely fresh
// account that had spent nothing that day, producing a false "You're out of SPLEX
// credits" ("This is incorrect because my account still had credits remaining").
// Capping the estimate at the same percentage of the DAILY pool (when the tier has
// one) restores migration 0003's original invariant — "every tier can always
// afford several complex-classified requests from a fresh pool" — to the daily
// pool too, not just the monthly one it was originally written against. A smaller
// gate estimate never under-protects: the gate's only job is "is there roughly
// enough room to attempt this," and the real charge is still computed separately,
// from real usage, after generation.
export async function resolveCreditGateEstimate(
  fastify: FastifyInstance,
  complexity: ComplexityLevel,
  planTier: PlanTier,
): Promise<number> {
  const [bandResult, monthlyLimitResult, dailyLimitResult] = await Promise.all([
    fastify.supabaseAdmin.from("credit_cost_bands").select("min_percent").eq("complexity", complexity).single(),
    fastify.supabaseAdmin
      .from("plan_limits")
      .select("limit_amount")
      .eq("plan_tier", planTier)
      .eq("counter_type", "credits")
      .single(),
    fastify.supabaseAdmin
      .from("plan_limits")
      .select("limit_amount")
      .eq("plan_tier", planTier)
      .eq("counter_type", "daily_credits")
      .maybeSingle(),
  ]);

  if (bandResult.error || !bandResult.data || monthlyLimitResult.error || !monthlyLimitResult.data) {
    fastify.log.error(
      { bandError: bandResult.error, limitError: monthlyLimitResult.error, complexity, planTier },
      "credit gate estimate lookup failed, defaulting to a conservative flat estimate",
    );
    return 50;
  }

  const planTotal = monthlyLimitResult.data.limit_amount as number;
  const minPercent = bandResult.data.min_percent as number;
  const monthlyEstimate = Math.max(1, Math.ceil((planTotal * minPercent) / 100));

  // No daily cap configured for this tier (row missing, or explicitly null =
  // unlimited per this codebase's existing null-means-unlimited convention) —
  // nothing to cap against, use the monthly-relative estimate as-is.
  const dailyTotal = dailyLimitResult.error ? null : (dailyLimitResult.data?.limit_amount as number | null | undefined);
  if (typeof dailyTotal !== "number") return monthlyEstimate;

  const dailyEstimate = Math.max(1, Math.ceil((dailyTotal * minPercent) / 100));
  return Math.min(monthlyEstimate, dailyEstimate);
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
