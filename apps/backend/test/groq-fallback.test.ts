import { describe, it, expect, vi, afterEach } from "vitest";
import { makeState, makeFastify } from "./helpers/fakeFastify.js";
import { attemptGroqFallback, isOpenRouterCapacityExhausted } from "../src/groq/fallback.js";
import { OpenRouterError } from "../src/openrouter/client.js";
import { FairShareExceededError } from "../src/openrouter/capacity.js";
import type { AuthedUser } from "../src/types/index.js";

// The Groq fallback (migration 0056) — Free tier ONLY, and ONLY on a
// genuine OpenRouter capacity/rate-limit condition. See groq/fallback.ts's
// header comment for the full eligibility rule this file proves.
//
// Real key resolved: gsk_... authenticates against api.groq.com (Groq,
// Inc.), confirmed live NOT to be xAI's Grok (see db/migrations/0056).

function freeUser(overrides: Partial<AuthedUser> = {}): AuthedUser {
  return { id: "u1", email: "u1@example.com", planTier: "free", orgId: null, timezone: "UTC", ...overrides };
}

// Encodes a minimal, real Groq-shaped SSE stream: one token, then a final
// usage-carrying chunk, then [DONE] — same wire shape streamCompletion's
// own tests would use for OpenRouter, since Groq's endpoint is
// OpenAI-compatible and this codebase's parser is shared-shape.
function sseStream(text: string, usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage })}\n\n`,
    `data: [DONE]\n\n`,
  ];
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < frames.length) {
        controller.enqueue(encoder.encode(frames[i]));
        i++;
      } else {
        controller.close();
      }
    },
  });
}

function mockFetchOnce(response: { ok: boolean; status?: number; body?: ReadableStream<Uint8Array>; text?: string }) {
  const fn = vi.fn(async () => ({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    body: response.body ?? null,
    text: async () => response.text ?? "",
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const baseOpts = {
  category: "general",
  messages: [{ role: "user" as const, content: "hi" }],
  maxTokens: 512,
  onToken: () => {},
};

describe("isOpenRouterCapacityExhausted — the trigger predicate", () => {
  it("matches SPLEX's own pre-emptive fair-share denial", () => {
    expect(isOpenRouterCapacityExhausted(new FairShareExceededError())).toBe(true);
  });
  it("matches a live OpenRouter 429 (free-models-per-day)", () => {
    expect(isOpenRouterCapacityExhausted(new OpenRouterError("stream", 429, "free-models-per-day", "m:free"))).toBe(true);
  });
  it("matches a live OpenRouter 5xx", () => {
    expect(isOpenRouterCapacityExhausted(new OpenRouterError("stream", 503, "upstream busy", "m:free"))).toBe(true);
  });
  it("matches 403 (model access denied) and 404 (model unavailable) — both already retryable upstream", () => {
    expect(isOpenRouterCapacityExhausted(new OpenRouterError("stream", 403, "only available on agentic harnesses", "m:free"))).toBe(true);
    expect(isOpenRouterCapacityExhausted(new OpenRouterError("stream", 404, "No endpoints found", "m:free"))).toBe(true);
  });
  it("does NOT match a 401 (auth failure — not a capacity signal)", () => {
    expect(isOpenRouterCapacityExhausted(new OpenRouterError("stream", 401, "invalid API key", "m:free"))).toBe(false);
  });
  it("does NOT match a 402 (balance-exceeded — should never happen on a $0 :free model; masking it would hide a real problem)", () => {
    expect(isOpenRouterCapacityExhausted(new OpenRouterError("stream", 402, "insufficient credits", "m:free"))).toBe(false);
  });
  it("does NOT match a 400 (malformed request — would fail identically against Groq)", () => {
    expect(isOpenRouterCapacityExhausted(new OpenRouterError("stream", 400, "bad request", "m:free"))).toBe(false);
  });
  it("does NOT match a plain, unrelated Error", () => {
    expect(isOpenRouterCapacityExhausted(new Error("something else entirely"))).toBe(false);
  });
});

describe("attemptGroqFallback — Free tier ONLY (the single most important guarantee here)", () => {
  it("Free + capacity error + key configured -> attempts Groq and returns a result", async () => {
    const fastify = makeFastify(makeState({ groqAdmitResult: "ok" }));
    (fastify as unknown as { config: Record<string, unknown> }).config.GROQ_API_KEY = "gsk_test";
    mockFetchOnce({ ok: true, body: sseStream("served by fallback") });

    const result = await attemptGroqFallback({
      fastify, triggeringError: new FairShareExceededError(), user: freeUser(), ...baseOpts,
    });

    expect(result).not.toBeNull();
    expect(result!.generation.fullText).toBe("served by fallback");
    expect(result!.model.variant).toBe("free");
  });

  it("Paid (pro) tier -> NEVER attempts Groq, even with a triggering error and a configured key", async () => {
    const fastify = makeFastify(makeState({ groqAdmitResult: "ok" }));
    (fastify as unknown as { config: Record<string, unknown> }).config.GROQ_API_KEY = "gsk_test";
    const fetchMock = mockFetchOnce({ ok: true, body: sseStream("should never be reached") });

    const result = await attemptGroqFallback({
      fastify, triggeringError: new FairShareExceededError(), user: freeUser({ planTier: "pro" }), ...baseOpts,
    });

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dormant 'starter' tier -> NEVER attempts Groq either (only 'free' is eligible, not merely 'not pro')", async () => {
    const fastify = makeFastify(makeState({ groqAdmitResult: "ok" }));
    (fastify as unknown as { config: Record<string, unknown> }).config.GROQ_API_KEY = "gsk_test";
    const fetchMock = mockFetchOnce({ ok: true, body: sseStream("should never be reached") });

    const result = await attemptGroqFallback({
      fastify, triggeringError: new FairShareExceededError(),
      user: freeUser({ planTier: "starter" as never }), ...baseOpts,
    });

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("attemptGroqFallback — configuration and error-class gating", () => {
  it("no GROQ_API_KEY configured -> feature is off, returns null without attempting a call", async () => {
    const fastify = makeFastify(makeState({ groqAdmitResult: "ok" })); // GROQ_API_KEY undefined by fake's own default
    const fetchMock = mockFetchOnce({ ok: true, body: sseStream("should never be reached") });

    const result = await attemptGroqFallback({
      fastify, triggeringError: new FairShareExceededError(), user: freeUser(), ...baseOpts,
    });

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a non-capacity triggering error (401 auth) -> does not attempt Groq", async () => {
    const fastify = makeFastify(makeState({ groqAdmitResult: "ok" }));
    (fastify as unknown as { config: Record<string, unknown> }).config.GROQ_API_KEY = "gsk_test";
    const fetchMock = mockFetchOnce({ ok: true, body: sseStream("should never be reached") });

    const result = await attemptGroqFallback({
      fastify, triggeringError: new OpenRouterError("stream", 401, "invalid API key", "m:free"), user: freeUser(), ...baseOpts,
    });

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a 402 balance-exceeded triggering error -> does not attempt Groq", async () => {
    const fastify = makeFastify(makeState({ groqAdmitResult: "ok" }));
    (fastify as unknown as { config: Record<string, unknown> }).config.GROQ_API_KEY = "gsk_test";
    const fetchMock = mockFetchOnce({ ok: true, body: sseStream("should never be reached") });

    const result = await attemptGroqFallback({
      fastify, triggeringError: new OpenRouterError("stream", 402, "insufficient credits", "m:free"), user: freeUser(), ...baseOpts,
    });

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("attemptGroqFallback — Groq itself unavailable", () => {
  it("Groq admission denies (fair_share_exceeded) -> returns null, never throws its own error", async () => {
    const fastify = makeFastify(makeState({ groqAdmitResult: "fair_share_exceeded" }));
    (fastify as unknown as { config: Record<string, unknown> }).config.GROQ_API_KEY = "gsk_test";
    const fetchMock = mockFetchOnce({ ok: true, body: sseStream("should never be reached") });

    const result = await attemptGroqFallback({
      fastify, triggeringError: new FairShareExceededError(), user: freeUser(), ...baseOpts,
    });

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled(); // admission denial happens before any network call
  });

  it("Groq's own live call fails (e.g. its own 429) -> returns null so the caller rethrows the ORIGINAL OpenRouter error", async () => {
    const fastify = makeFastify(makeState({ groqAdmitResult: "ok" }));
    (fastify as unknown as { config: Record<string, unknown> }).config.GROQ_API_KEY = "gsk_test";
    mockFetchOnce({ ok: false, status: 429, text: "rate limited" });

    const result = await attemptGroqFallback({
      fastify, triggeringError: new FairShareExceededError(), user: freeUser(), ...baseOpts,
    });

    expect(result).toBeNull();
  });
});

describe("attemptGroqFallback — the served result is transparent to the caller (no exposed provider details)", () => {
  it("the returned model carries no raw account/quota mechanics beyond a normal openrouter_model_id-shaped string", async () => {
    const fastify = makeFastify(makeState({ groqAdmitResult: "ok" }));
    (fastify as unknown as { config: Record<string, unknown> }).config.GROQ_API_KEY = "gsk_test";
    mockFetchOnce({ ok: true, body: sseStream("hi") });

    const result = await attemptGroqFallback({
      fastify, triggeringError: new FairShareExceededError(), user: freeUser(), ...baseOpts,
    });

    expect(result).not.toBeNull();
    // Same field shape as any real OpenRouter candidate — downstream code
    // (friendlyModelName, computeRealCost, etc.) needs nothing Groq-specific.
    expect(result!.model.id).toBe("groq-fallback");
    expect(typeof result!.model.openrouter_model_id).toBe("string");
    expect(result!.model.cost_per_million_input).toBe(0);
    expect(result!.model.cost_per_million_output).toBe(0);
  });
});
