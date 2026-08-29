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

export type CreditRejectionReason =
  | "monthly_credits_exhausted"
  | "daily_credits_exhausted"
  | "daily_request_limit_exhausted"
  | "unknown_user"
  | "ok";

// Exported (not module-private) so callers with their own more specific
// existing credits-exhausted wording — Agent Workflow's ceiling check says
// "...to complete this multi-step request" rather than this generic
// string — can still reuse the exact same daily-limit text rather than
// duplicating the literal string at every call site.
// Deliberately generic — never "SPLEX credits", never a number. SPLEX
// credits are an internal backend metering unit; the user should see a
// normal product-style limit message, not internal accounting terms.
export const DAILY_REQUEST_LIMIT_MESSAGE = "You've reached your daily request limit. Please try again tomorrow.";
export const DAILY_CREDIT_LIMIT_MESSAGE = "Your current usage limit has been reached. Please try again tomorrow.";
const CREDITS_EXHAUSTED_MESSAGE = "Your current plan limit has been reached. Please try again later or upgrade your plan.";

// Determines WHY a preceding checkCredits()/checkAndReserveCredits() call
// returned false — never call this to decide whether to allow a request,
// only to explain a rejection that already happened. The underlying gate
// conflates three genuinely independent things for a Free-tier user: the
// MONTHLY credit pool, the separate DAILY credit pool (migration 0022),
// and a separate daily_requests MESSAGE-COUNT cap (plan_limits.daily_requests)
// — a single boolean can't tell a caller which one actually failed, which
// is exactly how a user with plenty of real credit balance left ends up
// being told "you're out of credits" after simply sending their 26th
// message of the day, or a user with monthly credits left gets no signal
// that it was specifically today's 150-credit pool that stopped them. This
// calls the read-only diagnose_credit_rejection() RPC (migration
// 0021/0022), which mirrors check_credits'/check_daily_credits' own checks
// exactly — same tables, same period boundaries, same order — so the
// reason it reports is always consistent with whatever the real gate
// already decided, not a second, potentially-racing guess made in
// application code.
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
    fastify.log.error({ error, userId }, "diagnose_credit_rejection RPC failed, defaulting to the monthly-credits-exhausted message");
    return "monthly_credits_exhausted";
  }
  return data as CreditRejectionReason;
}

// THE single place that turns "checkCredits() returned false" into the
// exact string a user sees — every gate in the app routes through this
// rather than re-deciding the wording itself, so the three messages can
// never drift apart or get reordered differently at different call sites.
//
// Precedence when multiple conditions are true: monthly_credits_exhausted
// wins over daily_credits_exhausted, which wins over
// daily_request_limit_exhausted. This exactly mirrors
// diagnose_credit_rejection()'s own check order (monthly pool -> daily
// pool -> daily message count), which itself mirrors check_credits()'s and
// check_daily_credits()'s real gating order — see migration 0022's doc
// comment. Only ever call this after the gate has already returned false
// for this exact request — it makes its own RPC call, so calling it
// speculatively on the success path would be pure wasted latency.
export async function resolveCreditRejectionMessage(
  fastify: FastifyInstance,
  userId: string,
  creditCost: number,
  options: CheckCreditsOptions = {},
): Promise<string> {
  const reason = await diagnoseCreditRejection(fastify, userId, creditCost, options);
  if (reason === "daily_request_limit_exhausted") return DAILY_REQUEST_LIMIT_MESSAGE;
  if (reason === "daily_credits_exhausted") return DAILY_CREDIT_LIMIT_MESSAGE;
  return CREDITS_EXHAUSTED_MESSAGE;
}

export interface ReserveResult {
  allowed: boolean;
  // Amount actually reserved against the DAILY pool (0 if monthlyOnly, or
  // if the gate never reached the daily reservation because the monthly
  // check already failed). Callers MUST pass this back to
  // settleDailyReservation() exactly once, on every exit path — success or
  // failure — or a reservation without a matching settle silently locks
  // that much of the user's daily pool for the rest of the day.
  dailyReserved: number;
}

// Replaces checkCredits() for the default (non-monthlyOnly) per-request /
// per-step gate. Monthly stays a pure read-only check (check_credits() —
// the monthly pool is large enough, and its own final charge doesn't drift
// far enough from a single request's estimate, that no atomicity fix is
// needed there). The daily pool is different: real per-request cost
// (charged from actual token usage) can be many times the pre-flight
// estimate, and the old design — read-only check now, additive consume
// seconds later once generation finishes — let the estimate-vs-real gap
// (and, independently, genuine concurrent requests) push daily usage well
// past the 150 cap. reserve_daily_credits() (migration 0022) closes both
// gaps at once: it atomically checks AND increments in one statement, so
// the reservation itself can never push `used` over the limit, and two
// concurrent callers serialize on Postgres's own row lock instead of both
// reading a stale `used` value.
//
// Every caller MUST call settleDailyReservation() exactly once after this
// resolves `allowed: true`, regardless of how generation turns out — see
// that function's doc comment for the required try/finally shape.
export async function checkAndReserveCredits(
  fastify: FastifyInstance,
  userId: string,
  creditCost: number,
): Promise<ReserveResult> {
  const monthly = await fastify.supabaseAdmin.rpc("check_credits", { p_user_id: userId, p_credit_cost: creditCost });
  if (monthly.error) {
    fastify.log.error({ error: monthly.error }, "check_credits RPC failed");
    return { allowed: false, dailyReserved: 0 };
  }
  if (!monthly.data) {
    return { allowed: false, dailyReserved: 0 };
  }

  const daily = await fastify.supabaseAdmin.rpc("reserve_daily_credits", {
    p_user_id: userId,
    p_reserve_amount: creditCost,
  });
  if (daily.error) {
    fastify.log.error({ error: daily.error }, "reserve_daily_credits RPC failed");
    return { allowed: false, dailyReserved: 0 };
  }
  if (!daily.data) {
    return { allowed: false, dailyReserved: 0 };
  }

  return { allowed: true, dailyReserved: creditCost };
}

// Settles a reservation made by checkAndReserveCredits(): trues up the
// daily pool from the ESTIMATE that was reserved to the REAL amount that
// should actually be charged. Pass actualCost: 0 on any failure/abort path
// (nothing should be charged at all) — that fully releases the
// reservation, since actualCost - reservedAmount = -reservedAmount, and
// consume_daily_credits() (unchanged, migration 0018) already accepts a
// signed delta. Pass the real computed cost on the success path — the
// delta can be positive (real cost exceeded the estimate, the common case)
// or negative (real cost came in under the estimate, refunding the
// difference).
//
// Required shape at every call site:
//
//   const gate = await checkAndReserveCredits(fastify, userId, estimate);
//   if (!gate.allowed) { ...explain via resolveCreditRejectionMessage...; return; }
//   let actualCost = 0;
//   try {
//     ...generate...
//     actualCost = realCost.creditsCharged; // set only once generation succeeded
//     ...consumeCredits() for the MONTHLY side, unchanged...
//   } finally {
//     await settleDailyReservation(fastify, userId, gate.dailyReserved, actualCost);
//   }
//
// finally fires on every exit — normal return, early return, thrown
// exception, client-abort — so actualCost staying at its 0 default
// correctly releases the reservation on any path that didn't reach the
// success assignment, with no need to hunt down every individual failure
// branch.
export async function settleDailyReservation(
  fastify: FastifyInstance,
  userId: string,
  reservedAmount: number,
  actualCost: number,
): Promise<void> {
  if (reservedAmount === 0) return; // monthlyOnly gate, or the gate never reached the reservation step
  const delta = actualCost - reservedAmount;
  if (delta === 0) return;
  const { error } = await fastify.supabaseAdmin.rpc("consume_daily_credits", { p_user_id: userId, p_credit_cost: delta });
  if (error) {
    fastify.log.error({ error, userId, reservedAmount, actualCost }, "settleDailyReservation: consume_daily_credits RPC failed");
  }
}

// ---------------------------------------------------------------------------
// Async (cross-request) reservations — video.
//
// checkAndReserveCredits/settleDailyReservation above are per-REQUEST: their
// contract is a try/finally inside one handler. An async video job is
// submitted in one request and charged in a later polling request, so the
// reservation has to outlive the request and live on the job row instead.
// See migration 0025 for the full rationale, including why the reservation
// records the daily period it was made against.
// ---------------------------------------------------------------------------

// Reserves against the daily pool AND stamps the generated_media row, in one
// atomic statement. The row must already exist (created status='queued'), so
// a reservation is never held without a record pointing at it — if the
// process died between reserving and recording, nothing could ever release it.
export async function reserveMediaCredits(
  fastify: FastifyInstance,
  mediaId: string,
  creditCost: number,
): Promise<boolean> {
  const { data, error } = await fastify.supabaseAdmin.rpc("reserve_media_credits", {
    p_media_id: mediaId,
    p_reserve_amount: creditCost,
  });
  if (error) {
    fastify.log.error({ error, mediaId }, "reserve_media_credits RPC failed");
    return false;
  }
  return data === true;
}

// Settles or fully releases a job's reservation. Idempotent server-side, so
// calling it on an already-settled job is a harmless no-op — which matters
// because the status endpoint is polled repeatedly and two polls can race on
// the same completing job.
//
// Pass actualCost 0 for any non-success outcome (failure, cancellation,
// expiry, submit error) to release the whole reservation.
export async function settleMediaReservation(
  fastify: FastifyInstance,
  mediaId: string,
  actualCost: number,
): Promise<void> {
  const { error } = await fastify.supabaseAdmin.rpc("settle_media_reservation", {
    p_media_id: mediaId,
    p_actual_cost: actualCost,
  });
  if (error) {
    fastify.log.error({ error, mediaId, actualCost }, "settle_media_reservation RPC failed");
  }
}

// Releases reservations pinned by jobs that were never polled to completion
// (tab closed, job stalled upstream). Best-effort and fire-and-forget at its
// call site: a sweep failure must never affect the request that triggered it.
export async function releaseStaleMediaReservations(fastify: FastifyInstance): Promise<number> {
  const { data, error } = await fastify.supabaseAdmin.rpc("release_stale_media_reservations", {});
  if (error) {
    fastify.log.warn({ error }, "release_stale_media_reservations RPC failed (non-fatal)");
    return 0;
  }
  return typeof data === "number" ? data : 0;
}
