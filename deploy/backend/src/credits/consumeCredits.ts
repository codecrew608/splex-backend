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

// Calls the service-role-only consume_credits() Postgres function. Only
// ever call this on a clean, successful completion — see the /chat route's
// failure-handling rules for why partial/failed generations must not charge.
export async function consumeCredits(fastify: FastifyInstance, params: ConsumeCreditsParams): Promise<void> {
  const { error } = await fastify.supabaseAdmin.rpc("consume_credits", {
    p_user_id: params.userId,
    p_credit_cost: params.creditCost,
    p_intent: params.intent,
    p_complexity: params.complexity,
    p_openrouter_model_id: params.openrouterModelId,
    p_real_cost_estimate: params.realCostEstimate,
    p_real_input_tokens: params.realInputTokens ?? null,
    p_real_output_tokens: params.realOutputTokens ?? null,
  });

  if (error) {
    fastify.log.error({ error }, "consume_credits RPC failed");
  }
}
