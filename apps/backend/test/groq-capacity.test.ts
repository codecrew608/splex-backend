import { describe, it, expect } from "vitest";
import { makeState, makeFastify } from "./helpers/fakeFastify.js";
import {
  admitGroqFallbackRequest,
  resolveTierBudget,
  isGroqFairShareExceededError,
  GroqFairShareExceededError,
} from "../src/groq/capacity.js";
import { isRetryableGroqError, isGroqRateLimitError, GroqError } from "../src/groq/client.js";

// Migration 0056 — Groq fallback capacity admission control, EXTENDED to
// Paid (2026-09-07): Free and Paid now share ONE real, physical Groq
// account limit, split into two independently-bookkept slices (see
// capacity.ts's resolveTierBudget) so neither tier can ever starve the
// other's allocation.
//
//   PROVES: capacity.ts derives both tier budgets from the SAME configured
//   total (never two independently-configured numbers that could silently
//   sum past the real account limit), calls admit_groq_fallback_request
//   with a tier-qualified bookkeeping key (never the real model id used for
//   dispatch), and reacts correctly to each of its 3 possible return
//   values.
//
//   DOES NOT PROVE: that the RPC itself enforces the joint cap under real
//   concurrency — a property of Postgres row-level locking a
//   single-threaded JS fake cannot meaningfully exercise. Proven
//   separately, against the real deployed function.

describe("resolveTierBudget", () => {
  it("Free and Paid derive from the SAME buffered total, never independently", async () => {
    // Stub config: total=1000, buffer=20% -> buffered=800; paid share=35%
    // -> paid=280, free=520. 280 + 520 = 800 exactly — the whole point.
    const fastify = makeFastify(makeState());
    const free = await resolveTierBudget(fastify, "free");
    const paid = await resolveTierBudget(fastify, "pro");
    expect(free.modelDailyCap + paid.modelDailyCap).toBe(800);
    expect(paid.modelDailyCap).toBe(280);
    expect(free.modelDailyCap).toBe(520);
  });

  it("Free and Paid get DIFFERENT bookkeeping model ids, both derived from the same real model", async () => {
    const fastify = makeFastify(makeState());
    const free = await resolveTierBudget(fastify, "free");
    const paid = await resolveTierBudget(fastify, "pro");
    expect(free.bookkeepingModelId).toBe("openai/gpt-oss-120b#free-tier");
    expect(paid.bookkeepingModelId).toBe("openai/gpt-oss-120b#paid-tier");
    expect(free.bookkeepingModelId).not.toBe(paid.bookkeepingModelId);
  });

  it("Paid's per-user share is computed from Paid's OWN slice, at Paid's OWN percentage — not Free's", async () => {
    // Paid slice = 280, per-user 25% of that = 70.
    const fastify = makeFastify(makeState());
    const paid = await resolveTierBudget(fastify, "pro");
    expect(paid.perUserDailyCap).toBe(70);
  });

  it("Free's per-user share is computed from Free's OWN slice, at Free's OWN (smaller) percentage", async () => {
    // Free slice = 520, per-user 5% of that = 26.
    const fastify = makeFastify(makeState());
    const free = await resolveTierBudget(fastify, "free");
    expect(free.perUserDailyCap).toBe(26);
  });

  it("Free + Paid can NEVER together exceed the buffered total, even under an extreme (100%) GROQ_PAID_SHARE_PCT misconfiguration", async () => {
    // The real edge case a naive independent-floor-per-branch implementation
    // gets wrong: at 100% paid share, a bare Math.max(1, ...) on each branch
    // independently could let Free floor to 1 while Paid kept the full
    // (now equal to bufferedTotal) raw share, summing to bufferedTotal + 1
    // — one request/day over the real account limit. This is the schema's
    // actual documented maximum (.max(100)), not a hypothetical value.
    const fastify = makeFastify(makeState());
    (fastify as unknown as { config: Record<string, number> }).config.GROQ_PAID_SHARE_PCT = 100;
    const free = await resolveTierBudget(fastify, "free");
    const paid = await resolveTierBudget(fastify, "pro");
    expect(free.modelDailyCap + paid.modelDailyCap).toBeLessThanOrEqual(800); // bufferedTotal at defaults
    expect(free.modelDailyCap).toBeGreaterThanOrEqual(1);
    expect(paid.modelDailyCap).toBeGreaterThanOrEqual(1);
  });

  it("the same invariant holds at 0% paid share too", async () => {
    const fastify = makeFastify(makeState());
    (fastify as unknown as { config: Record<string, number> }).config.GROQ_PAID_SHARE_PCT = 0;
    const free = await resolveTierBudget(fastify, "free");
    const paid = await resolveTierBudget(fastify, "pro");
    expect(free.modelDailyCap + paid.modelDailyCap).toBeLessThanOrEqual(800);
    expect(paid.modelDailyCap).toBeGreaterThanOrEqual(1);
  });

  it("exhaustively: every integer GROQ_PAID_SHARE_PCT from 0 to 100 keeps the invariant — sum never exceeds bufferedTotal, neither side ever below 1", async () => {
    // Not just the two edges — every value the schema allows (.min(0).max(100)).
    for (let pct = 0; pct <= 100; pct++) {
      const fastify = makeFastify(makeState());
      (fastify as unknown as { config: Record<string, number> }).config.GROQ_PAID_SHARE_PCT = pct;
      const free = await resolveTierBudget(fastify, "free");
      const paid = await resolveTierBudget(fastify, "pro");
      expect(free.modelDailyCap + paid.modelDailyCap, `pct=${pct}`).toBeLessThanOrEqual(800);
      expect(free.modelDailyCap, `pct=${pct}`).toBeGreaterThanOrEqual(1);
      expect(paid.modelDailyCap, `pct=${pct}`).toBeGreaterThanOrEqual(1);
    }
  });

  it("exhaustively: the same invariant holds across a range of small bufferedTotal values, including the genuinely degenerate ones (<2)", async () => {
    for (const totalCapacity of [1, 2, 3, 5, 10, 50]) {
      for (const pct of [0, 5, 35, 50, 95, 100]) {
        const fastify = makeFastify(makeState());
        (fastify as unknown as { config: Record<string, number> }).config.GROQ_TOTAL_DAILY_CAPACITY = totalCapacity;
        (fastify as unknown as { config: Record<string, number> }).config.GROQ_SAFETY_BUFFER_PCT = 0; // isolate: bufferedTotal === totalCapacity
        (fastify as unknown as { config: Record<string, number> }).config.GROQ_PAID_SHARE_PCT = pct;
        const free = await resolveTierBudget(fastify, "free");
        const paid = await resolveTierBudget(fastify, "pro");
        // The one invariant that matters even in the degenerate <2 regime:
        // combined admission budget must never exceed the real capacity.
        expect(free.modelDailyCap + paid.modelDailyCap, `total=${totalCapacity} pct=${pct}`).toBeLessThanOrEqual(totalCapacity);
      }
    }
  });

  it("never returns a per-user cap less than 1, however small the computed share is", async () => {
    const fastify = makeFastify(makeState());
    (fastify as unknown as { config: Record<string, number> }).config.GROQ_TOTAL_DAILY_CAPACITY = 1;
    const free = await resolveTierBudget(fastify, "free");
    expect(free.perUserDailyCap).toBeGreaterThanOrEqual(1);
    expect(free.modelDailyCap).toBeGreaterThanOrEqual(1);
  });

  it("never promises more attempts than the tier's own daily_requests entitlement", async () => {
    const fastify = makeFastify(makeState({ planLimits: { daily_requests: 7 } }));
    (fastify as unknown as { config: Record<string, number> }).config.GROQ_TOTAL_DAILY_CAPACITY = 100000;
    (fastify as unknown as { config: Record<string, number> }).config.GROQ_PER_USER_SHARE_PCT = 100;
    const free = await resolveTierBudget(fastify, "free");
    expect(free.perUserDailyCap).toBeLessThanOrEqual(7);
  });
});

describe("admitGroqFallbackRequest", () => {
  it("resolves without throwing when the RPC says ok", async () => {
    const state = makeState({ groqAdmitResult: "ok" });
    const fastify = makeFastify(state);
    await expect(admitGroqFallbackRequest(fastify, "u1", "free", "openai/gpt-oss-120b")).resolves.toBeUndefined();
  });

  it("calls the RPC with the real user id, a TIER-QUALIFIED bookkeeping model id (not the raw dispatch model), and config-derived caps", async () => {
    const state = makeState({ groqAdmitResult: "ok" });
    const fastify = makeFastify(state);
    await admitGroqFallbackRequest(fastify, "the-real-user-id", "free", "openai/gpt-oss-120b");
    const call = state.rpcCalls.find((c) => c.name === "admit_groq_fallback_request");
    expect(call).toBeDefined();
    expect(call!.params).toMatchObject({
      p_user_id: "the-real-user-id",
      p_model_id: "openai/gpt-oss-120b#free-tier",
    });
    expect(typeof call!.params.p_per_user_daily_cap).toBe("number");
    expect(typeof call!.params.p_model_daily_cap).toBe("number");
  });

  it("a Paid caller gets the paid-tier bookkeeping key, not the free one", async () => {
    const state = makeState({ groqAdmitResult: "ok" });
    const fastify = makeFastify(state);
    await admitGroqFallbackRequest(fastify, "u1", "pro", "openai/gpt-oss-120b");
    const call = state.rpcCalls.find((c) => c.name === "admit_groq_fallback_request");
    expect(call!.params.p_model_id).toBe("openai/gpt-oss-120b#paid-tier");
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
