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
