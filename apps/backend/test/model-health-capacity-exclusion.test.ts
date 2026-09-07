import { describe, it, expect } from "vitest";
import { makeState, makeFastify } from "./helpers/fakeFastify.js";
import { recordModelFailure } from "../src/cortex/modelHealth.js";
import { OpenRouterError } from "../src/openrouter/client.js";
import { FairShareExceededError } from "../src/openrouter/capacity.js";

// The same class of bug modelHealth.ts's own doc comment already warns
// about for the 402 balance-exceeded case ("A billing state must never be
// laundered into model-quality data") applies identically to the two new
// error types migration 0054 introduces: neither a per-user fair-share
// rejection nor a per-model daily-capacity hit says anything about the
// SERVED MODEL's own quality or uptime. Recording either as a model
// failure would be exactly the bug that made topping up OpenRouter credit
// not immediately restore normal service (see modelHealth.ts's comment) —
// applied to a different account-level condition.
//
// Assertions read state.rpcCalls synchronously, with no await: calling the
// fake's `rpc()` mock pushes into rpcCalls before the first await inside
// its own async body runs, so the push has already happened by the time
// recordModelFailure (itself synchronous up to its fire-and-forget calls)
// returns control here — see fakeFastify.ts's rpc mock.

describe("recordModelFailure — account-level conditions excluded from model health", () => {
  it("a fair-share rejection records NO model_health RPC call", () => {
    const state = makeState();
    const fastify = makeFastify(state);
    recordModelFailure(fastify, "model-row-id", new FairShareExceededError(), 50);
    expect(state.rpcCalls.find((c) => c.name === "record_model_health")).toBeUndefined();
  });

  it("a fair-share rejection does NOT deactivate the model registry row", () => {
    const state = makeState();
    const fastify = makeFastify(state);
    recordModelFailure(fastify, "model-row-id", new FairShareExceededError(), 50);
    // deactivateUnavailableModel logs at "error" level distinctively —
    // absence of any error-level log is the observable proxy available
    // through this fake for "no deactivation was attempted".
    expect(state.logs.some((l) => l.level === "error")).toBe(false);
  });

  it("a free-model daily-capacity hit records NO model_health RPC call", () => {
    const state = makeState();
    const fastify = makeFastify(state);
    const err = new OpenRouterError(
      "stream", 429,
      '{"error":{"message":"Rate limit exceeded: free-models-per-day"}}',
      "vendor/model:free",
    );
    recordModelFailure(fastify, "model-row-id", err, 50);
    expect(state.rpcCalls.find((c) => c.name === "record_model_health")).toBeUndefined();
  });

  it("a free-model daily-capacity hit does NOT deactivate the model — it will have room again tomorrow", () => {
    const state = makeState();
    const fastify = makeFastify(state);
    const err = new OpenRouterError(
      "stream", 429,
      '{"error":{"message":"Rate limit exceeded: free-models-per-day"}}',
      "vendor/model:free",
    );
    recordModelFailure(fastify, "model-row-id", err, 50);
    expect(state.logs.some((l) => l.level === "error")).toBe(false);
  });

  it("a free-model daily-capacity hit DOES mark that model's own capacity counter exhausted, KEYED BY THE OPENROUTER STRING ID", () => {
    const state = makeState();
    const fastify = makeFastify(state);
    const err = new OpenRouterError(
      "stream", 429,
      '{"error":{"message":"Rate limit exceeded: free-models-per-day"}}',
      "vendor/model:free",
    );
    recordModelFailure(fastify, "model-row-id", err, 50, "vendor/model:free");
    const call = state.rpcCalls.find((c) => c.name === "mark_provider_model_exhausted");
    expect(call).toBeDefined();
    // REGRESSION (found live, 2026-09-07): marking exhaustion by the
    // model_registry ROW ID ("model-row-id", a uuid) instead of the
    // OpenRouter STRING id writes a row admitOpenRouterFreeRequest can
    // never match, since that function always looks up by
    // model.openrouter_model_id — silently defeating the entire reactive
    // layer while looking correct in every log line. Two such rows shipped
    // to production before this was caught by a real end-to-end request,
    // not by any test — this pins the fix so it cannot regress silently
    // again.
    expect(call!.params.p_model_id).toBe("vendor/model:free");
    expect(call!.params.p_model_id).not.toBe("model-row-id");
  });

  it("without an openrouterModelId, degrades to a log-only warning rather than writing a wrongly-keyed row", () => {
    // Every EXISTING call site was updated to pass it, so this path is not
    // expected to trigger in practice — but if a FUTURE call site forgets
    // to, this proves the failure mode is "no capacity tracking for that
    // one call" (safe, degrades gracefully), never "a garbage row silently
    // written under the wrong key" (the actual bug this file exists to
    // catch).
    const state = makeState();
    const fastify = makeFastify(state);
    const err = new OpenRouterError(
      "stream", 429,
      '{"error":{"message":"Rate limit exceeded: free-models-per-day"}}',
      "vendor/model:free",
    );
    recordModelFailure(fastify, "model-row-id", err, 50); // openrouterModelId omitted
    expect(state.rpcCalls.find((c) => c.name === "mark_provider_model_exhausted")).toBeUndefined();
    expect(state.logs.some((l) => l.level === "warn")).toBe(true);
  });

  it("control: an ORDINARY failure still records against model health as before", () => {
    // Proves the two new branches narrow correctly rather than swallowing
    // every failure — a genuine model-side error must still be scored.
    const state = makeState();
    const fastify = makeFastify(state);
    const err = new OpenRouterError("stream", 500, "internal server error", "vendor/model:free");
    recordModelFailure(fastify, "model-row-id", err, 50);
    expect(state.rpcCalls.find((c) => c.name === "record_model_health")).toBeDefined();
  });
});
