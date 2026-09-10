import type { FastifyInstance } from "fastify";
import type { OptimizationOutcome } from "./types.js";

// Same posture as persistence/cortexDecisions.ts's insertCortexDecision:
// fire-and-forget, logs on failure, never throws — a telemetry write must
// never fail or slow down the real response whose content has already
// been decided by the time this is called.
export async function recordOptimizationOutcome(
  fastify: FastifyInstance,
  messageId: string,
  userId: string,
  outcome: OptimizationOutcome,
): Promise<void> {
  const { error } = await fastify.supabaseAdmin.from("prompt_optimizer_outcomes").insert({
    message_id: messageId,
    user_id: userId,
    was_optimized: outcome.wasOptimized,
    method: outcome.method,
    bypass_reason: outcome.bypassReason,
    original_tokens_est: outcome.originalTokensEst,
    optimized_tokens_est: outcome.optimizedTokensEst,
    reduction_pct: outcome.reductionPct,
    optimizer_model: outcome.optimizerModel,
    optimizer_cost_usd: outcome.optimizerCostUsd,
    optimizer_latency_ms: outcome.optimizerLatencyMs,
    downstream_savings_usd: outcome.downstreamSavingsUsd,
    net_savings_usd: outcome.netSavingsUsd,
    validation_passed: outcome.validationPassed,
  });

  if (error) {
    fastify.log.error({ error }, "Failed to insert prompt_optimizer_outcomes row");
  }
}
