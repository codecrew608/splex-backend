import type { FastifyInstance } from "fastify";
import type { PlanTier } from "@splex/shared-types";

// Which model runs SPLEX's own internal calls — the fallback classifier,
// workflow planning, and memory extraction.
//
// THE PROBLEM THIS FIXES
//
// All three used fastify.config.CORTEX_CLASSIFIER_MODEL_ID unconditionally,
// and in production that is qwen/qwen-2.5-72b-instruct — a PAID model
// (pricing.prompt 0.00000036, verified against the live OpenRouter
// catalogue). So a Free user sending an ambiguous message, or simply
// having their memory updated, billed real provider spend to the SPLEX
// account:
//
//   * it broke the tier isolation the whole routing layer is built to
//     guarantee — selectModelCandidates goes to great lengths (variant
//     filter + a redundant cost-safety guard) to keep Free traffic on
//     :free models, and these three calls walked straight around it;
//   * the spend is invisible: it is never charged to the user's credits
//     and never appears in credit_usage_logs, so it scales silently with
//     free signups;
//   * it couples Free-tier functionality to the paid account's balance.
//     If that balance is exhausted, these calls 402 — which is a strong
//     candidate for the repeated memory-extraction failures in the
//     production logs, since chat itself (on :free models) keeps working.
//
// Paid tiers keep the configured model: classification quality matters
// more there, the spend is already covered by the subscription, and it is
// the behaviour those users are paying for.
export async function resolveClassifierModel(fastify: FastifyInstance, planTier: PlanTier): Promise<string> {
  if (planTier !== "free") {
    return fastify.config.CORTEX_CLASSIFIER_MODEL_ID;
  }

  // Highest-priority active free-variant general model — the same pool
  // ordinary Free chat draws from, so this can never introduce paid spend.
  const { data, error } = await fastify.supabaseAdmin
    .from("model_registry")
    .select("openrouter_model_id")
    .eq("category", "general")
    .eq("variant", "free")
    .eq("is_active", true)
    .eq("free_tier_allowed", true)
    .order("priority", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error || !data?.openrouter_model_id) {
    // Fail LOUD rather than silently reaching for the paid model: a Free
    // request quietly costing money is exactly the failure this module
    // exists to prevent, and it would be invisible without this log.
    fastify.log.error(
      { error, planTier },
      "no active free-variant general model for internal classification — falling back to the configured (paid) model",
    );
    return fastify.config.CORTEX_CLASSIFIER_MODEL_ID;
  }

  return data.openrouter_model_id as string;
}
