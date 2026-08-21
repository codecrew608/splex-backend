import type { FastifyInstance } from "fastify";
import type { ModelRegistryRow, OpenRouterUsage } from "../types/index.js";

export interface RealCostResult {
  creditsCharged: number;
  realCostEstimateUsd: number;
  inputTokens: number;
  outputTokens: number;
}

// SPLEX Credits are deliberately NOT a fixed 1:1 mapping to real model tokens —
// this is the conversion rate between actual $ cost and the credit currency
// shown to users. Tunable without touching the credit *meaning* users see.
const DEFAULT_CREDITS_PER_USD = 20_000;

// Free-tier requests route to $0 :free models, but the pool still needs to
// mean something — so free-tier usage is priced against the category's PAID
// row (the "shadow cost" of what the task would have cost on the paid
// equivalent), not the literal $0 it actually cost SPLEX. This is what makes
// the charge reflect real task/model cost rather than either a flat token
// count or a meaningless-for-free-tier $0.
async function resolveShadowPricing(
  fastify: FastifyInstance,
  category: string,
  servedModel: ModelRegistryRow,
): Promise<{ costPerMillionInput: number; costPerMillionOutput: number }> {
  if (servedModel.variant === "paid") {
    return {
      costPerMillionInput: servedModel.cost_per_million_input,
      costPerMillionOutput: servedModel.cost_per_million_output,
    };
  }

  const { data, error } = await fastify.supabaseAdmin
    .from("model_registry")
    .select("cost_per_million_input, cost_per_million_output")
    .eq("category", category)
    .eq("variant", "paid")
    .eq("is_active", true)
    .order("priority", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    // No paid equivalent exists for this category — fall back to a nominal
    // reference rate rather than charging $0 (which would make the free
    // pool meaningless for this category).
    fastify.log.warn({ error, category }, "no paid shadow-pricing row found, using nominal fallback rate");
    return { costPerMillionInput: 0.1, costPerMillionOutput: 0.3 };
  }

  return {
    costPerMillionInput: data.cost_per_million_input as number,
    costPerMillionOutput: data.cost_per_million_output as number,
  };
}

export async function computeRealCost(
  fastify: FastifyInstance,
  category: string,
  servedModel: ModelRegistryRow,
  usage: OpenRouterUsage | null,
): Promise<RealCostResult> {
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;

  const pricing = await resolveShadowPricing(fastify, category, servedModel);
  const realCostEstimateUsd =
    (inputTokens / 1_000_000) * pricing.costPerMillionInput + (outputTokens / 1_000_000) * pricing.costPerMillionOutput;

  const creditsPerUsd = fastify.config.CREDITS_PER_USD ?? DEFAULT_CREDITS_PER_USD;
  // Floor of 1 credit — nothing is ever genuinely free, even a tiny reply
  // from a $0 free-tier model, so the pool always ticks down a little.
  const creditsCharged = Math.max(1, Math.ceil(realCostEstimateUsd * creditsPerUsd));

  return { creditsCharged, realCostEstimateUsd, inputTokens, outputTokens };
}
