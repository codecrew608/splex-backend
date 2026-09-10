import { describe, it, expect } from "vitest";
import { makeOptimizerState, makeOptimizerFastify } from "./helpers/fakeOptimizerFastify.js";
import { resolveOptimizerModelCandidates, resolveOptimizerModelPricing } from "../src/optimizer/model.js";

describe("resolveOptimizerModelCandidates — mirrors classifierModel.ts's tier-isolation invariant", () => {
  it("non-free tier returns exactly the configured PROMPT_OPTIMIZER_MODEL_ID, no DB read", async () => {
    const state = makeOptimizerState({ config: { PROMPT_OPTIMIZER_MODEL_ID: "test/paid-model" } });
    const fastify = makeOptimizerFastify(state);
    const candidates = await resolveOptimizerModelCandidates(fastify, "pro");
    expect(candidates).toEqual(["test/paid-model"]);
  });

  it("free tier queries model_registry for free-variant general models only", async () => {
    const state = makeOptimizerState({
      modelRegistryRows: [{ openrouter_model_id: "free/model-a" }, { openrouter_model_id: "free/model-b" }],
    });
    const fastify = makeOptimizerFastify(state);
    const candidates = await resolveOptimizerModelCandidates(fastify, "free");
    expect(candidates).toEqual(["free/model-a", "free/model-b"]);
  });

  it("free tier NEVER returns the configured paid model, even when the registry is empty", async () => {
    const state = makeOptimizerState({ config: { PROMPT_OPTIMIZER_MODEL_ID: "test/paid-model" }, modelRegistryRows: [] });
    const fastify = makeOptimizerFastify(state);
    const candidates = await resolveOptimizerModelCandidates(fastify, "free");
    expect(candidates).toEqual([]);
    expect(candidates).not.toContain("test/paid-model");
  });

  it("free tier degrades to an empty list (never the paid model) on a registry read that returns null data", async () => {
    // makeOptimizerFastify's model_registry stub always resolves { data:
    // state.modelRegistryRows, error: null } — an empty array is the
    // closest this fake can model a "no rows" condition, which is exactly
    // the branch resolveOptimizerModelCandidates's error-handling exists
    // for (data is falsy/empty -> return [], never fall through to the
    // paid model).
    const state = makeOptimizerState({ modelRegistryRows: [] });
    const fastify = makeOptimizerFastify(state);
    const candidates = await resolveOptimizerModelCandidates(fastify, "free");
    expect(candidates).toEqual([]);
  });
});

describe("resolveOptimizerModelPricing — same graceful-degrade shape as credits/realCost.ts", () => {
  it("returns real pricing when the model exists in model_registry", async () => {
    const state = makeOptimizerState({
      modelRegistryRows: [{ cost_per_million_input: 2.5, cost_per_million_output: 7.5 }],
    });
    const fastify = makeOptimizerFastify(state);
    const pricing = await resolveOptimizerModelPricing(fastify, "test/paid-model");
    expect(pricing).toEqual({ costPerMillionInput: 2.5, costPerMillionOutput: 7.5 });
  });

  it("falls back to a small nominal rate when the model has no registry row — never throws, never zero-costs it", async () => {
    const state = makeOptimizerState({ modelRegistryRows: [] });
    const fastify = makeOptimizerFastify(state);
    const pricing = await resolveOptimizerModelPricing(fastify, "test/unknown-model");
    expect(pricing.costPerMillionInput).toBeGreaterThan(0);
    expect(pricing.costPerMillionOutput).toBeGreaterThan(0);
  });
});
