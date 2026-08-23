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

export type CreditRejectionReason = "credits_exhausted" | "daily_request_limit_exhausted" | "unknown_user" | "ok";

// Exported (not module-private) so callers with their own more specific
// existing credits-exhausted wording — Agent Workflow's ceiling check says
// "...to complete this multi-step request" rather than this generic
// string — can still reuse the exact same daily-limit text rather than
// duplicating the literal string at every call site.
export const DAILY_REQUEST_LIMIT_MESSAGE = "You've reached your daily request limit. Please try again tomorrow.";
const CREDITS_EXHAUSTED_MESSAGE = "You've used your available SPLEX credits.";

// Determines WHY a preceding checkCredits() call returned false — never
// call this to decide whether to allow a request, only to explain a
// rejection that already happened. check_credits() conflates two
// genuinely independent things for a Free-tier user: the monthly/daily
// CREDIT pools, and a separate daily_requests MESSAGE-COUNT cap
// (plan_limits.daily_requests) — a single boolean can't tell a caller
// which one actually failed, which is exactly how a user with plenty of
// real credit balance left ends up being told "you're out of credits"
// after simply sending their 26th message of the day. This calls the
// read-only diagnose_credit_rejection() RPC (migration 0021), which
// mirrors check_credits'/check_daily_credits' own checks exactly — same
// tables, same period boundaries, same order — so the reason it reports
// is always consistent with whatever the real gate already decided, not
// a second, potentially-racing guess made in application code.
export async function diagnoseCreditRejection(
  fastify: FastifyInstance,
  userId: string,
  creditCost: number,
  options: CheckCreditsOptions = {},
): Promise<CreditRejectionReason> {
  const { data, error } = await fastify.supabaseAdmin.rpc("diagnose_credit_rejection", {
    p_user_id: userId,
    p_credit_cost: creditCost,
    // Must match whatever mode the preceding checkCredits() call actually
    // used — a monthlyOnly caller never invoked check_daily_credits(), so
    // this RPC must not evaluate the daily credit pool either, or it could
    // report a rejection reason the real gate never actually checked.
    p_monthly_only: options.monthlyOnly ?? false,
  });
  if (error || typeof data !== "string") {
    fastify.log.error({ error, userId }, "diagnose_credit_rejection RPC failed, defaulting to the credits-exhausted message");
    return "credits_exhausted";
  }
  return data as CreditRejectionReason;
}

// THE single place that turns "checkCredits() returned false" into the
// exact string a user sees — every gate in the app routes through this
// rather than re-deciding the wording itself, so the two messages can
// never drift apart or get reordered differently at different call sites.
//
// Precedence when BOTH conditions are true: credits_exhausted wins. It's
// the more fundamental constraint (a user out of credits can't be served
// regardless of how many requests they've sent today), and this mirrors
// check_credits()'s own internal ordering — its monthly-credit check
// returns early, before its embedded daily_requests check ever runs (see
// migration 0021's doc comment for the full reasoning). Only ever call
// this after checkCredits() has already returned false for this exact
// request — it makes its own RPC call, so calling it speculatively on the
// success path would be pure wasted latency.
export async function resolveCreditRejectionMessage(
  fastify: FastifyInstance,
  userId: string,
  creditCost: number,
  options: CheckCreditsOptions = {},
): Promise<string> {
  const reason = await diagnoseCreditRejection(fastify, userId, creditCost, options);
  return reason === "daily_request_limit_exhausted" ? DAILY_REQUEST_LIMIT_MESSAGE : CREDITS_EXHAUSTED_MESSAGE;
}
