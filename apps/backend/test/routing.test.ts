import { describe, it, expect } from "vitest";
import {
  isRetryableOpenRouterError,
  isBalanceExceededError,
  isModelUnavailableError,
} from "../src/openrouter/client.js";
import { scoreModels, pickCandidates } from "../src/cortex/routing.js";
import type { ModelRegistryRow, ModelHealthRow } from "../src/types/index.js";

const err = (m: string) => new Error(m);

function model(over: Partial<ModelRegistryRow> = {}): ModelRegistryRow {
  return {
    id: over.id ?? "id-1",
    category: "general",
    openrouter_model_id: over.openrouter_model_id ?? "vendor/model",
    variant: over.variant ?? "free",
    capability_score: 70,
    context_length: 100_000,
    cost_per_million_input: 0,
    cost_per_million_output: 0,
    is_active: true,
    priority: 10,
    provider: "vendor",
    modality: "text",
    quality_score: 70,
    coding_score: 70,
    reasoning_score: 70,
    latency_score: 50,
    reliability_score: 70,
    free_tier_allowed: true,
    pro_tier_allowed: true,
    ...over,
  } as ModelRegistryRow;
}

describe("OpenRouter error classification", () => {
  // The production outage: a retired model answered 404, which matched
  // neither the retryable nor the balance branch, so the candidate loop
  // rethrew instead of trying the next Free model — a generic failure while
  // a perfectly good candidate sat unused.
  it("treats 404 / no-endpoints as retryable with a DIFFERENT model", () => {
    const e = err('OpenRouter request failed (404): No endpoints found for nvidia/nemotron-nano-9b-v2:free');
    expect(isModelUnavailableError(e)).toBe(true);
    expect(isRetryableOpenRouterError(e)).toBe(true);
    expect(isBalanceExceededError(e)).toBe(false);
  });

  it("treats 429 and 5xx as retryable but NOT model-unavailable", () => {
    for (const code of ["429", "500", "502", "503"]) {
      const e = err(`OpenRouter request failed (${code})`);
      expect(isRetryableOpenRouterError(e)).toBe(true);
      expect(isModelUnavailableError(e)).toBe(false);
    }
  });

  it("treats 402 as a balance problem, never retryable", () => {
    const e = err("OpenRouter request failed (402)");
    expect(isBalanceExceededError(e)).toBe(true);
    expect(isRetryableOpenRouterError(e)).toBe(false);
  });

  it("does NOT burn the fallback chain on request-shaped errors", () => {
    // 400/401/422 would fail identically against every candidate — retrying
    // just multiplies latency for the same outcome. A bad key or a malformed
    // body is not model-specific.
    for (const code of ["400", "401", "422"]) {
      expect(isRetryableOpenRouterError(err(`OpenRouter request failed (${code})`))).toBe(false);
    }
  });

  it("DOES continue the chain on 403 — it is model-specific, not key-specific", () => {
    // This assertion was previously the opposite, on the reasoning that 403
    // "would fail identically against every candidate". The live availability
    // probe (2026-08-29) disproved that: thinkingmachines/inkling:free
    // returned 403 "only available on agentic harnesses" while seven other
    // free models returned 200 on the SAME key in the SAME run. A 403 is
    // therefore a property of the model, not of the credentials, and aborting
    // the chain on one throws away working candidates.
    expect(isRetryableOpenRouterError(err("OpenRouter request failed (403)"))).toBe(true);
    // ...but it must NOT mark the model unavailable: that predicate drives
    // auto-deactivation, and a genuinely key-wide 403 would then strip the
    // registry of every model at once.
    expect(isModelUnavailableError(err("OpenRouter request failed (403)"))).toBe(false);
  });

  it("classifies the classifier endpoint's errors the same way", () => {
    expect(isModelUnavailableError(err("OpenRouter classifier request failed (404)"))).toBe(true);
    expect(isRetryableOpenRouterError(err("OpenRouter classifier request failed (429)"))).toBe(true);
  });

  it("ignores non-Error values", () => {
    for (const v of [null, undefined, "404", 404, {}]) {
      expect(isRetryableOpenRouterError(v)).toBe(false);
      expect(isModelUnavailableError(v)).toBe(false);
      expect(isBalanceExceededError(v)).toBe(false);
    }
  });
});

// Mirrors the candidate loop in handlers/chat.ts: advance on a retryable
// error unless this is the last candidate.
function runChain(models: string[], failures: Record<string, Error>) {
  const attempted: string[] = [];
  for (let i = 0; i < models.length; i++) {
    attempted.push(models[i]);
    const e = failures[models[i]];
    if (!e) return { attempted, succeeded: models[i] };
    const isLast = i === models.length - 1;
    if (!isLast && isRetryableOpenRouterError(e)) continue;
    return { attempted, succeeded: null, threw: e };
  }
  return { attempted, succeeded: null };
}

describe("fallback chain behaviour", () => {
  const dead = err('OpenRouter request failed (404): No endpoints found for dead/model');

  it("skips a dead model and succeeds on the next candidate", () => {
    const r = runChain(["dead", "good"], { dead });
    expect(r.succeeded).toBe("good");
    expect(r.attempted).toEqual(["dead", "good"]);
  });

  it("skips a rate-limited model and succeeds on the next", () => {
    const r = runChain(["busy", "good"], { busy: err("OpenRouter request failed (429)") });
    expect(r.succeeded).toBe("good");
  });

  it("walks past MULTIPLE dead models to a live one", () => {
    const r = runChain(["d1", "d2", "good"], { d1: dead, d2: dead });
    expect(r.succeeded).toBe("good");
    expect(r.attempted).toHaveLength(3);
  });

  it("stops immediately on a non-retryable error without burning candidates", () => {
    const r = runChain(["bad", "good"], { bad: err("OpenRouter request failed (401)") });
    expect(r.succeeded).toBeNull();
    expect(r.attempted).toEqual(["bad"]); // never tried "good"
  });

  it("gives up only after every candidate is exhausted", () => {
    const r = runChain(["d1", "d2"], { d1: dead, d2: dead });
    expect(r.succeeded).toBeNull();
    expect(r.attempted).toEqual(["d1", "d2"]);
  });
});

describe("Free/Pro isolation and scoring", () => {
  const health = new Map<string, ModelHealthRow>();

  it("v1 (Free) and v1.5 (Pro) use genuinely different scoring", () => {
    const models = [
      model({ id: "a", quality_score: 95, cost_per_million_input: 8, cost_per_million_output: 8 }),
      model({ id: "b", quality_score: 60, cost_per_million_input: 0, cost_per_million_output: 0 }),
    ];
    const v1 = scoreModels(models, health, "general", "simple", "v1");
    const v15 = scoreModels(models, health, "general", "simple", "v1.5");
    // Both produce a full ranking; the weightings differ by version, which is
    // the architectural split between the engines.
    expect(v1).toHaveLength(2);
    expect(v15).toHaveLength(2);
    expect(v1.map((s) => s.score)).not.toEqual(v15.map((s) => s.score));
  });

  it("v1 returns 2 fallback candidates, v1.5 returns 3", () => {
    const models = [model({ id: "a" }), model({ id: "b" }), model({ id: "c" }), model({ id: "d" })];
    expect(pickCandidates(scoreModels(models, health, "general", "medium", "v1"), "v1", 2)).toHaveLength(2);
    expect(pickCandidates(scoreModels(models, health, "general", "medium", "v1.5"), "v1.5", 3)).toHaveLength(3);
  });

  it("a cheaper model outranks an expensive one on a simple Free request", () => {
    const models = [
      model({ id: "pricey", quality_score: 80, cost_per_million_input: 10, cost_per_million_output: 10 }),
      model({ id: "cheap", quality_score: 75, cost_per_million_input: 0, cost_per_million_output: 0 }),
    ];
    const ranked = pickCandidates(scoreModels(models, health, "general", "simple", "v1"), "v1", 2);
    expect(ranked[0].model.id).toBe("cheap");
  });

  it("live health drags down a failing model once there are enough observations", () => {
    const failing = new Map<string, ModelHealthRow>([
      ["bad", { model_id: "bad", success_count: 1, failure_count: 19, timeout_count: 0, total_latency_ms: 1000, total_cost_usd: 0, last_failure_at: null } as ModelHealthRow],
    ]);
    const models = [model({ id: "bad", quality_score: 90 }), model({ id: "ok", quality_score: 75 })];
    // v1.5 blends live health; v1 deliberately does not.
    const ranked = pickCandidates(scoreModels(models, failing, "general", "medium", "v1.5"), "v1.5", 2);
    expect(ranked[0].model.id).toBe("ok");
  });

  it("ignores health below the minimum observation count", () => {
    const thin = new Map<string, ModelHealthRow>([
      ["bad", { model_id: "bad", success_count: 0, failure_count: 2, timeout_count: 0, total_latency_ms: 0, total_cost_usd: 0, last_failure_at: null } as ModelHealthRow],
    ]);
    const models = [model({ id: "bad", quality_score: 95 }), model({ id: "ok", quality_score: 60 })];
    const ranked = pickCandidates(scoreModels(models, thin, "general", "medium", "v1.5"), "v1.5", 2);
    // One unlucky pair of failures must not bench a strong model.
    expect(ranked[0].model.id).toBe("bad");
  });
});
