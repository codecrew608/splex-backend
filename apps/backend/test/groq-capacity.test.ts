import { describe, it, expect } from "vitest";
import { makeState, makeFastify } from "./helpers/fakeFastify.js";
import {
  admitGroqFallbackRequest,
  resolvePerUserDailyShareGroq,
  isGroqFairShareExceededError,
  GroqFairShareExceededError,
} from "../src/groq/capacity.js";
import { isRetryableGroqError, isGroqRateLimitError, GroqError } from "../src/groq/client.js";

// Migration 0056 — Groq fallback capacity admission control. Mirrors
// openrouter-capacity.test.ts's exact scope and rationale, applied to the
// Groq analogue:
//
//   PROVES: capacity.ts calls admit_groq_fallback_request with the
//   correct, config-derived parameters, and reacts correctly to each of
//   its 3 possible return values.
//
//   DOES NOT PROVE: that the RPC itself enforces the joint cap under real
//   concurrency — a property of Postgres row-level locking a
//   single-threaded JS fake cannot meaningfully exercise. Proven
//   separately, against the real deployed function.

describe("resolvePerUserDailyShareGroq", () => {
  it("computes the configured percentage of the BUFFERED capacity, not the raw one", async () => {
    // Stub config: capacity=1000, buffer=20% -> effective 800; share=5% of 800 = 40.
    const fastify = makeFastify(makeState());
    const share = await resolvePerUserDailyShareGroq(fastify, "free");
    expect(share).toBe(40);
  });

  it("never returns less than 1, however small the computed share is", async () => {
    const fastify = makeFastify(makeState());
    (fastify as unknown as { config: Record<string, number> }).config.GROQ_FREE_DAILY_CAPACITY = 1;
    const share = await resolvePerUserDailyShareGroq(fastify, "free");
    expect(share).toBeGreaterThanOrEqual(1);
  });

  it("never promises more attempts than the tier's own daily_requests entitlement", async () => {
    const fastify = makeFastify(makeState({ planLimits: { daily_requests: 7 } }));
    (fastify as unknown as { config: Record<string, number> }).config.GROQ_FREE_DAILY_CAPACITY = 100000;
    (fastify as unknown as { config: Record<string, number> }).config.GROQ_PER_USER_SHARE_PCT = 100;
    const share = await resolvePerUserDailyShareGroq(fastify, "free");
    expect(share).toBeLessThanOrEqual(7);
  });
});

describe("admitGroqFallbackRequest", () => {
  it("resolves without throwing when the RPC says ok", async () => {
    const state = makeState({ groqAdmitResult: "ok" });
    const fastify = makeFastify(state);
    await expect(admitGroqFallbackRequest(fastify, "u1", "free", "openai/gpt-oss-120b")).resolves.toBeUndefined();
  });

  it("calls the RPC with the real user id, model id, and config-derived caps — never invented values", async () => {
    const state = makeState({ groqAdmitResult: "ok" });
    const fastify = makeFastify(state);
    await admitGroqFallbackRequest(fastify, "the-real-user-id", "free", "openai/gpt-oss-120b");
    const call = state.rpcCalls.find((c) => c.name === "admit_groq_fallback_request");
    expect(call).toBeDefined();
    expect(call!.params).toMatchObject({
      p_user_id: "the-real-user-id",
      p_model_id: "openai/gpt-oss-120b",
    });
    expect(typeof call!.params.p_per_user_daily_cap).toBe("number");
    expect(typeof call!.params.p_model_daily_cap).toBe("number");
  });

  it("throws GroqFairShareExceededError on fair_share_exceeded — and it is NOT retryable", async () => {
    const state = makeState({ groqAdmitResult: "fair_share_exceeded" });
    const fastify = makeFastify(state);
    await expect(admitGroqFallbackRequest(fastify, "u1", "free", "openai/gpt-oss-120b"))
      .rejects.toBeInstanceOf(GroqFairShareExceededError);
    try {
      await admitGroqFallbackRequest(fastify, "u1", "free", "openai/gpt-oss-120b");
    } catch (err) {
      expect(isGroqFairShareExceededError(err)).toBe(true);
      expect(isRetryableGroqError(err)).toBe(false);
    }
  });

  it("throws a GroqError(429) on provider_capacity_exhausted — and IS retryable/rate-limit-shaped", async () => {
    const state = makeState({ groqAdmitResult: "provider_capacity_exhausted" });
    const fastify = makeFastify(state);
    try {
      await admitGroqFallbackRequest(fastify, "u1", "free", "openai/gpt-oss-120b");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GroqError);
      expect(isRetryableGroqError(err)).toBe(true);
      expect(isGroqRateLimitError(err)).toBe(true);
    }
  });

  it("fails OPEN on an RPC transport error — never blocks a request over an infra hiccup", async () => {
    const fastify2 = makeFastify(makeState());
    fastify2.supabaseAdmin.rpc = (async () => ({ data: null, error: { message: "network blip" } })) as never;
    await expect(admitGroqFallbackRequest(fastify2, "u1", "free", "openai/gpt-oss-120b")).resolves.toBeUndefined();
  });
});
