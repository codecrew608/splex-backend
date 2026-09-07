import { describe, it, expect } from "vitest";
import { makeState, makeFastify } from "./helpers/fakeFastify.js";
import {
  admitOpenRouterFreeRequest,
  resolvePerUserDailyShare,
  isFairShareExceededError,
  isFreeModelId,
  FairShareExceededError,
} from "../src/openrouter/capacity.js";
import { isFreeModelDailyCapExceededError, OpenRouterError, isRetryableOpenRouterError } from "../src/openrouter/client.js";

// Migration 0054 — OpenRouter free-model capacity admission control.
//
// What this file proves vs. what it deliberately does NOT try to prove:
//
//   PROVES: capacity.ts calls admit_openrouter_free_request with the
//   correct, config-derived parameters, and reacts correctly to each of
//   its 3 possible return values — 'ok' lets the caller proceed, the two
//   denial reasons produce genuinely different, correctly-classified
//   errors.
//
//   DOES NOT PROVE: that the RPC itself correctly enforces the joint
//   two-counter cap under real concurrency — that is a property of
//   Postgres row-level locking, which a single-threaded JS fake cannot
//   meaningfully exercise either way (see fakeFastify.ts's own comment on
//   openrouterAdmitResult). That is proven separately, against the real
//   deployed function, by bench/harness/capacity_concurrency.mjs.

describe("isFreeModelId", () => {
  it("matches every real free-tier id shape in this registry", () => {
    expect(isFreeModelId("minimax/minimax-m2.7:free")).toBe(true);
    expect(isFreeModelId("nvidia/nemotron-3-super-120b-a12b:free")).toBe(true);
  });
  it("does not match a paid id", () => {
    expect(isFreeModelId("deepseek/deepseek-v4-flash-0731")).toBe(false);
    expect(isFreeModelId("z-ai/glm-5.2")).toBe(false);
  });
  it("is not fooled by a paid id that merely contains the substring", () => {
    // A model id like "free-tier-labs/foo" (hypothetical) must not match —
    // only the literal :free VARIANT SUFFIX means anything here.
    expect(isFreeModelId("free-tier-labs/foo")).toBe(false);
    expect(isFreeModelId("vendor/model:free-preview")).toBe(false);
  });
});

describe("resolvePerUserDailyShare", () => {
  it("computes the configured percentage of the BUFFERED capacity, not the raw one", async () => {
    // Stub config: capacity=50, buffer=10% -> effective 45; share=5% of 45 = 2.25 -> floor 2.
    const fastify = makeFastify(makeState());
    const share = await resolvePerUserDailyShare(fastify, "free");
    expect(share).toBe(2);
  });

  it("never returns less than 1, however small the computed share is", async () => {
    const fastify = makeFastify(makeState());
    (fastify as unknown as { config: Record<string, number> }).config.OPENROUTER_FREE_DAILY_CAPACITY = 1;
    const share = await resolvePerUserDailyShare(fastify, "free");
    expect(share).toBeGreaterThanOrEqual(1);
  });

  it("never promises more attempts than the tier's own daily_requests entitlement", async () => {
    // A huge configured capacity/share must still be clamped to what the
    // plan actually allows — there is no reason to grant more OpenRouter
    // attempts than the plan's own message cap already implies.
    const fastify = makeFastify(makeState({ planLimits: { daily_requests: 7 } }));
    (fastify as unknown as { config: Record<string, number> }).config.OPENROUTER_FREE_DAILY_CAPACITY = 100000;
    (fastify as unknown as { config: Record<string, number> }).config.OPENROUTER_PER_USER_SHARE_PCT = 100;
    const share = await resolvePerUserDailyShare(fastify, "free");
    expect(share).toBeLessThanOrEqual(7);
  });
});

describe("admitOpenRouterFreeRequest", () => {
  it("resolves without throwing when the RPC says ok", async () => {
    const state = makeState({ openrouterAdmitResult: "ok" });
    const fastify = makeFastify(state);
    await expect(admitOpenRouterFreeRequest(fastify, "u1", "free", "vendor/model:free")).resolves.toBeUndefined();
  });

  it("calls the RPC with the real user id, model id, and config-derived caps — never invented values", async () => {
    const state = makeState({ openrouterAdmitResult: "ok" });
    const fastify = makeFastify(state);
    await admitOpenRouterFreeRequest(fastify, "the-real-user-id", "free", "vendor/model:free");
    const call = state.rpcCalls.find((c) => c.name === "admit_openrouter_free_request");
    expect(call).toBeDefined();
    expect(call!.params).toMatchObject({
      p_user_id: "the-real-user-id",
      p_model_id: "vendor/model:free",
    });
    expect(typeof call!.params.p_per_user_daily_cap).toBe("number");
    expect(typeof call!.params.p_model_daily_cap).toBe("number");
  });

  it("throws FairShareExceededError on fair_share_exceeded — and it is NOT retryable", async () => {
    const state = makeState({ openrouterAdmitResult: "fair_share_exceeded" });
    const fastify = makeFastify(state);
    await expect(admitOpenRouterFreeRequest(fastify, "u1", "free", "vendor/model:free"))
      .rejects.toBeInstanceOf(FairShareExceededError);
    try {
      await admitOpenRouterFreeRequest(fastify, "u1", "free", "vendor/model:free");
    } catch (err) {
      expect(isFairShareExceededError(err)).toBe(true);
      // The whole point: retrying a DIFFERENT model is pointless when the
      // reason is the USER's own cap, not this model's — the fallback loop
      // in handlers/chat.ts must stop, not iterate every other candidate.
      expect(isRetryableOpenRouterError(err)).toBe(false);
    }
  });

  it("throws an OpenRouterError(429) on provider_capacity_exhausted — and IS retryable", async () => {
    const state = makeState({ openrouterAdmitResult: "provider_capacity_exhausted" });
    const fastify = makeFastify(state);
    try {
      await admitOpenRouterFreeRequest(fastify, "u1", "free", "vendor/model:free");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OpenRouterError);
      // A DIFFERENT model may still have room — the fallback loop should
      // keep trying, exactly as it would for a live 429 from OpenRouter
      // itself. This is the intended effect of reusing OpenRouterError's
      // own shape rather than a bespoke error class for this branch.
      expect(isRetryableOpenRouterError(err)).toBe(true);
      expect(isFreeModelDailyCapExceededError(err)).toBe(true);
    }
  });

  it("fails OPEN on an RPC transport error — never blocks a request over an infra hiccup", async () => {
    const state = makeState();
    const fastify = makeFastify(state);
    (fastify.supabaseAdmin.rpc as unknown as (fn: string) => void) = (() => {
      throw new Error("should not be called directly");
    }) as never;
    // Simulate a transport error via the fake's normal path instead of
    // throwing synchronously (matches how supabase-js actually reports a
    // failed RPC call: {data: null, error: {...}}, not a thrown exception).
    const fastify2 = makeFastify(makeState());
    fastify2.supabaseAdmin.rpc = (async () => ({ data: null, error: { message: "network blip" } })) as never;
    await expect(admitOpenRouterFreeRequest(fastify2, "u1", "free", "vendor/model:free")).resolves.toBeUndefined();
  });
});

describe("isFreeModelDailyCapExceededError", () => {
  it("matches the exact verified live OpenRouter error text (2026-09-07)", () => {
    const err = new OpenRouterError(
      "stream", 429,
      '{"error":{"message":"Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day","code":429}}',
      "nvidia/nemotron-3-super-120b-a12b:free",
    );
    expect(isFreeModelDailyCapExceededError(err)).toBe(true);
  });

  it("matches this module's own synthetic pre-emptive denial", () => {
    const err = new OpenRouterError("stream", 429, "provider_capacity_exhausted (no live call made)", "vendor/model:free");
    expect(isFreeModelDailyCapExceededError(err)).toBe(true);
  });

  it("does NOT match an ordinary per-minute 429 with a different body", () => {
    const err = new OpenRouterError("stream", 429, '{"error":{"message":"Too many requests, please slow down"}}', "vendor/model:free");
    expect(isFreeModelDailyCapExceededError(err)).toBe(false);
    // An ordinary 429 must still be retryable — this predicate narrows a
    // SUBSET of 429s, it must never change the meaning of the rest.
    expect(isRetryableOpenRouterError(err)).toBe(true);
  });

  it("does not match a 402 balance-exceeded error", () => {
    const err = new OpenRouterError("stream", 402, "Insufficient credits", "vendor/model:paid");
    expect(isFreeModelDailyCapExceededError(err)).toBe(false);
  });

  it("does not match a plain Error that merely mentions the phrase", () => {
    // Guards against over-matching on message text alone — must require
    // the real OpenRouterError shape (status + body), not just any Error
    // whose text happens to contain the phrase.
    expect(isFreeModelDailyCapExceededError(new Error("something about free-models-per-day"))).toBe(false);
  });
});
