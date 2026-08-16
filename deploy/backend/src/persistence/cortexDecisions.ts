import type { FastifyInstance } from "fastify";
import type { ComplexityLevel } from "../shared-types.js";

export interface InsertCortexDecisionParams {
  messageId: string;
  intent: string;
  complexity: ComplexityLevel;
  capabilities: string[];
  category: string;
  reason: string;
  modelSelected: string; // INTERNAL ONLY — real openrouter_model_id.
}

// Service-role only, per cortex_decisions' RLS (zero policies). Never query
// or expose this table's model_selected column to a client.
export async function insertCortexDecision(fastify: FastifyInstance, params: InsertCortexDecisionParams): Promise<void> {
  const { error } = await fastify.supabaseAdmin.from("cortex_decisions").insert({
    message_id: params.messageId,
    intent: params.intent,
    complexity: params.complexity,
    capabilities: params.capabilities,
    category: params.category,
    reason: params.reason,
    model_selected: params.modelSelected,
  });

  if (error) {
    fastify.log.error({ error }, "Failed to insert cortex_decisions row");
  }
}
