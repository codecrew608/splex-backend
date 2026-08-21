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
): Promise<void> {
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    const { error } = await fastify.supabaseAdmin.rpc(rpcName, rpcParams);
    if (!error) return;

    const isLastAttempt = attempt === RETRY_ATTEMPTS;
    fastify.log[isLastAttempt ? "error" : "warn"](
      { error, attempt, ...logContext },
      isLastAttempt ? `${rpcName} RPC failed after retries — ledger may be under-charged` : `${rpcName} RPC failed, retrying`,
    );
    if (!isLastAttempt) await sleep(RETRY_DELAY_MS * attempt);
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
  );

  await callWithRetry(fastify, "consume_daily_credits", { p_user_id: params.userId, p_credit_cost: params.creditCost }, logContext);
}
