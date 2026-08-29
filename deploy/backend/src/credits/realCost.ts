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
// Calibrated for the ₹199/month paid plan (100,000 credits) — see
// db/migrations/0032. The arithmetic that fixes this number:
//
//   ₹199/month  ~= $2.25 revenue
//   target provider spend at FULL monthly exhaustion: ~35% of revenue
//   => 100,000 credits must map to ~$0.83 of provider cost
//   => 100,000 / 0.83  ~= 120,000 credits per USD
//
// Sanity-checked against real pool pricing (migration 0032) for a mixed day
// of 20 simple + 5 medium + 1 complex request: ~3,150 credits, comfortably
// inside the 3,300 daily cap, at ~$0.026/day => ~$0.79/month. That is the
// intended shape — a heavy user gets strong models and simply consumes their
// allowance faster, rather than being served deliberately worse answers.
//
// This is an INTERNAL usage unit, not a literal provider conversion the user
// ever sees: it is the dial between real $ cost and the credit currency, and
// it is tuned here in one place rather than smeared across handlers.
export const DEFAULT_CREDITS_PER_USD = 120_000;

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

  // Ordered by COST, not by priority.
  //
  // Priority ranks routing preference, so the top-priority paid row is
  // whichever model is best for the job — often the most expensive one.
  // Pricing free usage against that would be perverse: after migration 0032
  // the general primary is GLM 5.2 at $1.19/$3.74, which would make a single
  // ordinary Free chat cost ~528 credits against a 500/day Free cap. One
  // message would exhaust the day.
  //
  // The cheapest active paid row is the defensible floor. Free usage costs
  // SPLEX nothing in reality (:free models bill $0), so the shadow price is a
  // policy choice about what a Free credit should mean — and the honest
  // choice is "what this would have cost on the cheapest paid equivalent",
  // not on the most expensive one.
  const { data, error } = await fastify.supabaseAdmin
    .from("model_registry")
    .select("cost_per_million_input, cost_per_million_output")
    .eq("category", category)
    .eq("variant", "paid")
    .eq("is_active", true)
    .order("cost_per_million_output", { ascending: true })
    .order("cost_per_million_input", { ascending: true })
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
