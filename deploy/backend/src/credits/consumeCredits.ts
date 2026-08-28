import type { FastifyInstance } from "fastify";
import type { ComplexityLevel } from "../shared-types.js";

export interface ConsumeCreditsParams {
  userId: string;
  creditCost: number;
  intent: string;
  complexity: ComplexityLevel;
  openrouterModelId: string;
  realCostEstimate: number;
  realInputTokens?: number;
  realOutputTokens?: number;
  // Skip the daily counter because a RESERVATION already covers it.
  //
  // Reserve/settle and consume are two complete ways to charge the daily
  // pool, and running both double-charges it. That is not hypothetical: it
  // shipped. From the moment migration 0022's reservation gate went live,
  // every chat message added estimate (reserve) + actual (here) +
  // actual-estimate (settle) = 2 x actual to the daily counter. Production
  // data for 2026-08-27 shows daily_counter 138 against 69 actually
  // charged in credit_usage_logs — an exact 2.00 ratio, where every day
  // before the reservation gate reads 1.00. Free users were hitting their
  // 150/day cap at ~75 credits of real usage.
  //
  // The monthly pool and the credit_usage_logs ledger are unaffected and
  // still written here in every case — only the daily counter is skipped,
  // because settleDailyReservation()/settleMediaReservation() already trues
  // it up from the reserved estimate to the real amount.
  skipDaily?: boolean;
}

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Shared by both the monthly and daily RPC calls below — same retry
// rationale either way: the billable work already happened (OpenRouter was
// already called and already cost real money) by the time either of these
// runs, so a transient blip here must not silently leave the ledger
// under-charged while the client is told creditsCharged succeeded.
async function callWithRetry(
  fastify: FastifyInstance,
  rpcName: string,
  rpcParams: Record<string, unknown>,
  logContext: Record<string, unknown>,
  failure: { userId: string; creditCost: number; intent: string; pool: "monthly" | "daily" },
): Promise<void> {
  let lastError: { message?: string } | null = null;

  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    const { error } = await fastify.supabaseAdmin.rpc(rpcName, rpcParams);
    if (!error) return;
    lastError = error;

    const isLastAttempt = attempt === RETRY_ATTEMPTS;
    fastify.log[isLastAttempt ? "error" : "warn"](
      { error, attempt, ...logContext },
      isLastAttempt ? `${rpcName} RPC failed after retries — ledger may be under-charged` : `${rpcName} RPC failed, retrying`,
    );
    if (!isLastAttempt) await sleep(RETRY_DELAY_MS * attempt);
  }

  // Every retry failed. The billable work already happened, so the counters
  // are now permanently short by creditCost with only a log line to show for
  // it — and logs age out. Record it durably so the gap is recoverable.
  //
  // Deliberately NOT an auto-retry: replaying a charge without knowing
  // whether the original partially applied risks double-charging, which is
  // worse than under-charging. This preserves the fact; a human decides.
  await recordChargeFailure(fastify, rpcName, lastError, failure);
}

async function recordChargeFailure(
  fastify: FastifyInstance,
  rpcName: string,
  lastError: { message?: string } | null,
  failure: { userId: string; creditCost: number; intent: string; pool: "monthly" | "daily" },
): Promise<void> {
  const { error } = await fastify.supabaseAdmin.from("credit_charge_failures").insert({
    user_id: failure.userId,
    rpc_name: rpcName,
    credit_cost: failure.creditCost,
    intent: failure.intent,
    pool: failure.pool,
    error_message: lastError?.message ?? null,
  });

  if (error) {
    // The last line of defence itself failed. Nothing else can capture this,
    // so make it as loud and as complete as possible — this exact log line is
    // the only remaining trace of real spend that was never charged.
    fastify.log.error(
      { error, ...failure, rpcName, originalError: lastError?.message },
      "CRITICAL: charge failed AND could not be recorded — usage is under-counted with no durable record",
    );
  }
}

// Calls the service-role-only consume_credits() AND consume_daily_credits()
// Postgres functions — the monthly pool (existing, migration 0004) and the
// daily pool (migration 0018) are tracked as two independent counters, both
// consumed on every successful charge. Only ever call this on a clean,
// successful completion — see the /chat route's failure-handling rules for
// why partial/failed generations must not charge.
export async function consumeCredits(fastify: FastifyInstance, params: ConsumeCreditsParams): Promise<void> {
  const logContext = { userId: params.userId, creditCost: params.creditCost };

  await callWithRetry(
    fastify,
    "consume_credits",
    {
      p_user_id: params.userId,
      p_credit_cost: params.creditCost,
      p_intent: params.intent,
      p_complexity: params.complexity,
      p_openrouter_model_id: params.openrouterModelId,
      p_real_cost_estimate: params.realCostEstimate,
      p_real_input_tokens: params.realInputTokens ?? null,
      p_real_output_tokens: params.realOutputTokens ?? null,
    },
    logContext,
    { userId: params.userId, creditCost: params.creditCost, intent: params.intent, pool: "monthly" },
  );

  // Callers that reserved up-front settle the daily side themselves; charging
  // it again here is a straight double-count. See skipDaily's doc comment.
  if (!params.skipDaily) {
    await callWithRetry(
      fastify,
      "consume_daily_credits",
      { p_user_id: params.userId, p_credit_cost: params.creditCost },
      logContext,
      { userId: params.userId, creditCost: params.creditCost, intent: params.intent, pool: "daily" },
    );
  }
}
