import type { FastifyInstance } from "fastify";
import type { PlanTier } from "@splex/shared-types";

// Which model runs the optimizer's semantic (Layer B) call — mirrors
// cortex/classifierModel.ts's resolveClassifierModelCandidates EXACTLY,
// same invariant and same reason: an internal, non-user-facing call must
// never silently reach a paid model on a Free request. In practice this
// optimizer is only ever invoked for planTier === "pro" (see
// optimizer/index.ts's own gate, and handlers/chat.ts's call site) — but
// this function still enforces the tier boundary itself rather than
// trusting every future caller to have gated correctly first. Defense in
// depth, not redundant: the exact class of bug this guards against
// (an internal call quietly reaching paid inference on a non-paying
// request) has shipped before in this codebase — see classifierModel.ts's
// own header for the incident.
export async function resolveOptimizerModelCandidates(fastify: FastifyInstance, planTier: PlanTier): Promise<string[]> {
  if (planTier !== "free") {
    return [fastify.config.PROMPT_OPTIMIZER_MODEL_ID];
  }

  const { data, error } = await fastify.supabaseAdmin
    .from("model_registry")
    .select("openrouter_model_id")
    .eq("category", "general")
    .eq("variant", "free")
    .eq("is_active", true)
    .eq("free_tier_allowed", true)
    .order("priority", { ascending: true });

  if (error || !data || data.length === 0) {
    fastify.log.error(
      { error, planTier },
      "no active free-variant general model for prompt optimization — skipping rather than spending on the paid model",
    );
    return [];
  }

  return (data as Array<{ openrouter_model_id: string }>).map((row) => row.openrouter_model_id);
}

export interface OptimizerModelPricing {
  costPerMillionInput: number;
  costPerMillionOutput: number;
}

// Same graceful-degrade shape as credits/realCost.ts's resolveShadowPricing:
// a model configured for internal use (via PROMPT_OPTIMIZER_MODEL_ID, the
// same pattern as CORTEX_CLASSIFIER_MODEL_ID) is not guaranteed to have a
// model_registry row of its own — that table is keyed for ROUTING
// (category/variant), not a lookup table for every model id this backend
// references anywhere. A direct id match is attempted first since it's
// exact when available; the fallback rate is deliberately small (this is
// a cheap/free-tier-class model by design, per spec item 2's "do NOT use
// an expensive frontier model") rather than a shrug-and-guess value.
const NOMINAL_OPTIMIZER_COST_PER_MILLION = { input: 0.1, output: 0.3 };

export async function resolveOptimizerModelPricing(fastify: FastifyInstance, modelId: string): Promise<OptimizerModelPricing> {
  const { data, error } = await fastify.supabaseAdmin
    .from("model_registry")
    .select("cost_per_million_input, cost_per_million_output")
    .eq("openrouter_model_id", modelId)
    .eq("is_active", true)
    .maybeSingle();

  if (error || !data) {
    return {
      costPerMillionInput: NOMINAL_OPTIMIZER_COST_PER_MILLION.input,
      costPerMillionOutput: NOMINAL_OPTIMIZER_COST_PER_MILLION.output,
    };
  }

  return {
    costPerMillionInput: data.cost_per_million_input as number,
    costPerMillionOutput: data.cost_per_million_output as number,
  };
}
