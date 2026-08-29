import type { FastifyInstance } from "fastify";
import type { PlanTier } from "../shared-types.js";

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
export async function resolveClassifierModel(fastify: FastifyInstance, planTier: PlanTier): Promise<string | null> {
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
    // Return NULL — never the configured (paid) model.
    //
    // Falling back to the paid model here was a real, if narrow, paid-leak
    // path for Free users: a transient model_registry error was enough to
    // put a Free request on paid inference. It logged loudly, but it still
    // spent. "Free tier never reaches a paid model" has to hold on the
    // error paths too, or it isn't an invariant.
    //
    // Skipping classification entirely is a genuinely cheap fallback: the
    // caller already degrades to the general intent when classification is
    // unavailable (see classify.ts), which is the same outcome a failed
    // classifier call produces — minus the spend.
    fastify.log.error(
      { error, planTier },
      "no active free-variant general model for internal classification — skipping LLM classification rather than spending on the paid model",
    );
    return null;
  }

  return data.openrouter_model_id as string;
}
