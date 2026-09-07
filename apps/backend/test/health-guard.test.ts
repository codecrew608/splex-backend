import { describe, it, expect } from "vitest";
import { isDemonstrablyUnhealthy, applyHealthGuard, scoreModels } from "../src/cortex/routing.js";
import type { ModelRegistryRow, ModelHealthRow } from "../src/types/index.js";

/**
 * The health guard exists because SFB v1.0 measured a Free-tier pool that
 * could not self-correct: Cortex v1 never reads model_health, so a model with
 * zero successes and five failures stayed the first candidate while one with
 * 57 successes and zero failures sat last.
 *
 * These tests pin the two properties that make the guard safe to run on every
 * version, including v1:
 *   - it demotes only models with ENOUGH observations to be judged, so one
 *     unlucky 429 cannot bench a good model;
 *   - it never empties a pool, because a bad candidate still beats none.
 */

function model(over: Partial<ModelRegistryRow> = {}): ModelRegistryRow {
  return {
    id: over.id ?? "m1",
    category: "general",
    openrouter_model_id: over.openrouter_model_id ?? "vendor/model:free",
    variant: "free",
    capability_score: 70,
    context_length: 100_000,
    cost_per_million_input: 0,
    cost_per_million_output: 0,
    is_active: true,
    priority: 10,
    provider: "vendor",
    modality: "text",
    quality_score: 70,
    coding_score: null,
    reasoning_score: null,
    latency_score: 50,
    reliability_score: 70,
    free_tier_allowed: true,
    pro_tier_allowed: true,
    ...over,
  } as ModelRegistryRow;
}

function health(over: Partial<ModelHealthRow> = {}): ModelHealthRow {
  return {
    model_id: over.model_id ?? "m1",
    success_count: 0,
    failure_count: 0,
    timeout_count: 0,
    total_latency_ms: 0,
    total_cost_usd: 0,
    last_failure_at: null,
    ...over,
  } as ModelHealthRow;
}

describe("isDemonstrablyUnhealthy", () => {
  it("is false with no health record at all", () => {
    expect(isDemonstrablyUnhealthy(undefined)).toBe(false);
  });

  it("is false below the observation floor, however bad the record looks", () => {
    // 3 failures out of 3 is a 100% error rate, and still not enough
    // evidence: a single rate-limited window produces exactly this.
    expect(isDemonstrablyUnhealthy(health({ failure_count: 3 }))).toBe(false);
  });

  it("is true for a model that has never succeeded across enough attempts", () => {
    expect(isDemonstrablyUnhealthy(health({ failure_count: 5 }))).toBe(true);
  });

  it("counts timeouts as failures", () => {
    expect(isDemonstrablyUnhealthy(health({ timeout_count: 4 }))).toBe(true);
  });

  it("is false for a model that mostly works", () => {
    expect(isDemonstrablyUnhealthy(health({ success_count: 57, failure_count: 2 }))).toBe(false);
  });

  it("is false at a bad-but-not-hopeless error rate", () => {
    // 50% failing is a problem worth scoring against, not a reason to bench
    // the model outright. The guard is a floor, not the scorer.
    expect(isDemonstrablyUnhealthy(health({ success_count: 5, failure_count: 5 }))).toBe(false);
  });
});

describe("applyHealthGuard", () => {
  const good = model({ id: "good", openrouter_model_id: "a/good:free" });
  const dead = model({ id: "dead", openrouter_model_id: "b/dead:free" });
  const unknown = model({ id: "unknown", openrouter_model_id: "c/unknown:free" });

  const scored = [
    { model: dead, score: 100, breakdown: {} as never },
    { model: good, score: 90, breakdown: {} as never },
    { model: unknown, score: 80, breakdown: {} as never },
  ];
  const healthMap = new Map<string, ModelHealthRow>([
    ["dead", health({ model_id: "dead", failure_count: 9 })],
    ["good", health({ model_id: "good", success_count: 57 })],
  ]);

  it("moves a demonstrably dead model behind healthy ones", () => {
    const out = applyHealthGuard(scored, healthMap);
    expect(out.map((s) => s.model.id)).toEqual(["good", "unknown", "dead"]);
  });

  it("never drops a candidate — the pool size is unchanged", () => {
    // Emptying a category's pool would turn a degraded answer into no answer
    // at all, which is strictly worse for the user.
    expect(applyHealthGuard(scored, healthMap)).toHaveLength(scored.length);
  });

  it("keeps the scorer's ordering within each group", () => {
    const out = applyHealthGuard(scored, healthMap);
    const healthy = out.filter((s) => s.model.id !== "dead");
    expect(healthy.map((s) => s.score)).toEqual([90, 80]);
  });

  it("is a no-op when nothing has a health record", () => {
    expect(applyHealthGuard(scored, new Map()).map((s) => s.model.id))
      .toEqual(["dead", "good", "unknown"]);
  });

  it("still returns every model when ALL of them are unhealthy", () => {
    const allBad = new Map<string, ModelHealthRow>([
      ["dead", health({ model_id: "dead", failure_count: 9 })],
      ["good", health({ model_id: "good", failure_count: 9 })],
      ["unknown", health({ model_id: "unknown", failure_count: 9 })],
    ]);
    expect(applyHealthGuard(scored, allBad)).toHaveLength(3);
  });
});

describe("the guard applies on v1, where scoreModels deliberately ignores health", () => {
  it("v1 scoring is unchanged by health, but the guard still reorders", () => {
    const a = model({ id: "a", openrouter_model_id: "x/a:free", quality_score: 90 });
    const b = model({ id: "b", openrouter_model_id: "y/b:free", quality_score: 60 });
    const h = new Map<string, ModelHealthRow>([
      ["a", health({ model_id: "a", failure_count: 9 })],
    ]);

    // v1 scores purely on configured values, so the failing model wins.
    const scoredV1 = scoreModels([a, b], h, "general", "simple", "v1");
    expect(scoredV1[0].model.id).toBe("a");

    // The guard is what corrects it, without touching the scoring profile.
    expect(applyHealthGuard(scoredV1, h)[0].model.id).toBe("b");
  });
});
