import type { FastifyInstance } from "fastify";

export interface CheckCreditsOptions {
  // Set for CEILING-style pre-flight checks only — Deep Research's
  // costCeilingCredits and Agent Workflow's estimatedTotal (perStepEstimate
  // x step count) are deliberately large, worst-case "can this whole
  // multi-step thing even be afforded from the user's overall balance"
  // numbers, not a realistic per-call cost. Live testing caught this
  // exact gap the day daily credits shipped: Deep Research's 6,000-credit
  // ceiling checked clean against Starter's 15,000 monthly pool but always
  // failed against the 750 daily pool, on a completely fresh account that
  // had spent nothing — the daily pool was never the thing a ceiling
  // check should be measured against. Real per-unit-of-work spend (one
  // workflow step, one chat message, one search) still goes through the
  // default both-pools check below — Agent Workflow's own per-step
  // checkCredits call (orchestrator.ts) already does this correctly today;
  // Deep Research's stages currently only consume (never gate) per-stage,
  // bounded instead by deep_research's own 3/day capability count and this
  // same monthly ceiling — narrower than full per-stage daily gating, but
  // strictly no looser than Deep Research's behavior before daily credits
  // existed at all.
  monthlyOnly?: boolean;
}

// Calls the service-role-only check_credits() AND (unless monthlyOnly)
// check_daily_credits() Postgres functions — both must pass. Monthly
// (existing, migration 0004) and daily (migration 0018) are independent
// ceilings; either one being exhausted blocks the request, matching spec
// section 14's "capability quotas are independent from the credit pool"
// pattern applied to the credit pool's own two dimensions. Both RPCs are
// service-role-only by design (see db/migrations SQL) — must be called
// with the service-role client.
export async function checkCredits(
  fastify: FastifyInstance,
  userId: string,
  creditCost: number,
  options: CheckCreditsOptions = {},
): Promise<boolean> {
  if (options.monthlyOnly) {
    const { data, error } = await fastify.supabaseAdmin.rpc("check_credits", { p_user_id: userId, p_credit_cost: creditCost });
    if (error) {
      fastify.log.error({ error }, "check_credits RPC failed");
      return false;
    }
    return Boolean(data);
  }

  const [monthly, daily] = await Promise.all([
    fastify.supabaseAdmin.rpc("check_credits", { p_user_id: userId, p_credit_cost: creditCost }),
    fastify.supabaseAdmin.rpc("check_daily_credits", { p_user_id: userId, p_credit_cost: creditCost }),
  ]);

  if (monthly.error) {
    fastify.log.error({ error: monthly.error }, "check_credits RPC failed");
    return false;
  }
  if (daily.error) {
    fastify.log.error({ error: daily.error }, "check_daily_credits RPC failed");
    return false;
  }

  return Boolean(monthly.data) && Boolean(daily.data);
}
