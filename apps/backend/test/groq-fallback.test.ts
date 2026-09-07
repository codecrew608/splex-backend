import { describe, it, expect, vi, afterEach } from "vitest";
import { makeState, makeFastify } from "./helpers/fakeFastify.js";
import { attemptGroqFallback, isOpenRouterCapacityExhausted } from "../src/groq/fallback.js";
import { OpenRouterError } from "../src/openrouter/client.js";
import { FairShareExceededError } from "../src/openrouter/capacity.js";
import type { AuthedUser } from "../src/types/index.js";

// The Groq fallback (migration 0056) — EXTENDED to Paid (2026-09-07, user's
// explicit direction). Paid's OpenRouter account holds $0 purchased credit
// by the user's own indefinite choice, so Paid dispatch failures today are
// almost entirely 402 balance-exceeded — the exact condition this
// extension exists to cover. See groq/fallback.ts's header comment for the
// full, deliberately tier-DIFFERENT eligibility rule this file proves:
// Free never falls back on 402 (would signal something is actually
// broken); Paid does (it's the expected, routine failure mode today).
//
// Real key resolved: gsk_... authenticates against api.groq.com (Groq,
// Inc.), confirmed live NOT to be xAI's Grok (see db/migrations/0056).

function makeUser(overrides: Partial<AuthedUser> = {}): AuthedUser {
  return { id: "u1", email: "u1@example.com", planTier: "free", orgId: null, timezone: "UTC", ...overrides };
}

// Encodes a minimal, real Groq-shaped SSE stream — see the client's own
// SSE parser, shared shape with OpenRouter's since Groq is OpenAI-compatible.
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

function withKey(fastify: ReturnType<typeof makeFastify>) {
  (fastify as unknown as { config: Record<string, unknown> }).config.GROQ_API_KEY = "gsk_test";
  return fastify;
}

describe("isOpenRouterCapacityExhausted — the SHARED trigger predicate (both tiers)", () => {
  it("matches SPLEX's own pre-emptive fair-share denial", () => {
    expect(isOpenRouterCapacityExhausted(new FairShareExceededError())).toBe(true);
  });
  it("matches a live OpenRouter 429 and 5xx", () => {
    expect(isOpenRouterCapacityExhausted(new OpenRouterError("stream", 429, "free-models-per-day", "m:free"))).toBe(true);
    expect(isOpenRouterCapacityExhausted(new OpenRouterError("stream", 503, "upstream busy", "m:free"))).toBe(true);
  });
  it("does NOT match 402 — that's the tier-DIFFERENT case, not this shared predicate", () => {
    expect(isOpenRouterCapacityExhausted(new OpenRouterError("stream", 402, "insufficient credits", "m:free"))).toBe(false);
  });
  it("does NOT match 401 or 400", () => {
    expect(isOpenRouterCapacityExhausted(new OpenRouterError("stream", 401, "invalid API key", "m:free"))).toBe(false);
    expect(isOpenRouterCapacityExhausted(new OpenRouterError("stream", 400, "bad request", "m:free"))).toBe(false);
  });
});

describe("attemptGroqFallback — Free tier: 402 is deliberately EXCLUDED", () => {
  it("Free + shared-predicate error (fair-share) + key configured -> attempts Groq", async () => {
    const fastify = withKey(makeFastify(makeState({ groqAdmitResult: "ok" })));
    mockFetchOnce({ ok: true, body: sseStream("served by fallback") });
    const result = await attemptGroqFallback({ fastify, triggeringError: new FairShareExceededError(), user: makeUser(), ...baseOpts });
    expect(result).not.toBeNull();
    expect(result!.generation.fullText).toBe("served by fallback");
  });

  it("Free + 402 balance-exceeded -> does NOT attempt Groq (this should never legitimately happen on a $0 model; masking it would hide a real problem)", async () => {
    const fastify = withKey(makeFastify(makeState({ groqAdmitResult: "ok" })));
    const fetchMock = mockFetchOnce({ ok: true, body: sseStream("should never be reached") });
    const result = await attemptGroqFallback({
      fastify, triggeringError: new OpenRouterError("stream", 402, "insufficient credits", "m:free"), user: makeUser(), ...baseOpts,
    });
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the Free-served model's variant is 'free' and it costs $0 shadow-priced, same as any other free-tier generation", async () => {
    const fastify = withKey(makeFastify(makeState({ groqAdmitResult: "ok" })));
    mockFetchOnce({ ok: true, body: sseStream("hi") });
    const result = await attemptGroqFallback({ fastify, triggeringError: new FairShareExceededError(), user: makeUser(), ...baseOpts });
    expect(result!.model.variant).toBe("free");
    expect(result!.model.cost_per_million_input).toBe(0);
    expect(result!.model.cost_per_million_output).toBe(0);
  });
});

describe("attemptGroqFallback — Paid tier: 402 IS the expected, routine trigger", () => {
  it("Paid + 402 balance-exceeded + key configured -> attempts Groq (the exact scenario this extension exists for)", async () => {
    const fastify = withKey(makeFastify(makeState({ groqAdmitResult: "ok" })));
    mockFetchOnce({ ok: true, body: sseStream("paid served by fallback") });
    const result = await attemptGroqFallback({
      fastify, triggeringError: new OpenRouterError("stream", 402, "insufficient credits", "m:paid"),
      user: makeUser({ planTier: "pro" }), ...baseOpts,
    });
    expect(result).not.toBeNull();
    expect(result!.generation.fullText).toBe("paid served by fallback");
  });

  it("Paid + a shared-predicate error (5xx) -> also attempts Groq, same as Free", async () => {
    const fastify = withKey(makeFastify(makeState({ groqAdmitResult: "ok" })));
    mockFetchOnce({ ok: true, body: sseStream("ok") });
    const result = await attemptGroqFallback({
      fastify, triggeringError: new OpenRouterError("stream", 503, "upstream busy", "m:paid"),
      user: makeUser({ planTier: "pro" }), ...baseOpts,
    });
    expect(result).not.toBeNull();
  });

  it("Paid + 401 auth -> does NOT attempt Groq (never a capacity/money signal, on either tier)", async () => {
    const fastify = withKey(makeFastify(makeState({ groqAdmitResult: "ok" })));
    const fetchMock = mockFetchOnce({ ok: true, body: sseStream("should never be reached") });
    const result = await attemptGroqFallback({
      fastify, triggeringError: new OpenRouterError("stream", 401, "invalid API key", "m:paid"),
      user: makeUser({ planTier: "pro" }), ...baseOpts,
    });
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the Paid-served model's variant is 'paid' and carries a REAL non-zero cost — Groq's own $0 cost to SPLEX must never leak into what the Paid user is charged", async () => {
    const fastify = withKey(makeFastify(makeState({ groqAdmitResult: "ok" })));
    mockFetchOnce({ ok: true, body: sseStream("hi") });
    const result = await attemptGroqFallback({
      fastify, triggeringError: new OpenRouterError("stream", 402, "insufficient credits", "m:paid"),
      user: makeUser({ planTier: "pro" }), ...baseOpts,
    });
    expect(result!.model.variant).toBe("paid");
    expect(result!.model.cost_per_million_input).toBeGreaterThan(0);
    expect(result!.model.cost_per_million_output).toBeGreaterThan(0);
  });

  it("dormant 'starter' tier is treated as Paid (non-free), not as a third, unhandled case", async () => {
    const fastify = withKey(makeFastify(makeState({ groqAdmitResult: "ok" })));
    mockFetchOnce({ ok: true, body: sseStream("hi") });
    const result = await attemptGroqFallback({
      fastify, triggeringError: new OpenRouterError("stream", 402, "insufficient credits", "m:paid"),
      user: makeUser({ planTier: "starter" as never }), ...baseOpts,
    });
    expect(result).not.toBeNull();
    expect(result!.model.variant).toBe("paid");
  });
});

describe("attemptGroqFallback — configuration gating (both tiers)", () => {
  it("no GROQ_API_KEY configured -> feature is off for Free", async () => {
    const fastify = makeFastify(makeState({ groqAdmitResult: "ok" })); // no withKey()
    const fetchMock = mockFetchOnce({ ok: true, body: sseStream("should never be reached") });
    const result = await attemptGroqFallback({ fastify, triggeringError: new FairShareExceededError(), user: makeUser(), ...baseOpts });
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no GROQ_API_KEY configured -> feature is off for Paid too", async () => {
    const fastify = makeFastify(makeState({ groqAdmitResult: "ok" }));
    const fetchMock = mockFetchOnce({ ok: true, body: sseStream("should never be reached") });
    const result = await attemptGroqFallback({
      fastify, triggeringError: new OpenRouterError("stream", 402, "insufficient credits", "m:paid"),
      user: makeUser({ planTier: "pro" }), ...baseOpts,
    });
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("attemptGroqFallback — Groq itself unavailable (both tiers)", () => {
  it("Groq admission denies -> returns null, never throws its own error", async () => {
    const fastify = withKey(makeFastify(makeState({ groqAdmitResult: "fair_share_exceeded" })));
    const fetchMock = mockFetchOnce({ ok: true, body: sseStream("should never be reached") });
    const result = await attemptGroqFallback({ fastify, triggeringError: new FairShareExceededError(), user: makeUser(), ...baseOpts });
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Groq's own live call fails -> returns null so the caller rethrows the ORIGINAL OpenRouter error", async () => {
    const fastify = withKey(makeFastify(makeState({ groqAdmitResult: "ok" })));
    mockFetchOnce({ ok: false, status: 429, text: "rate limited" });
    const result = await attemptGroqFallback({
      fastify, triggeringError: new OpenRouterError("stream", 402, "insufficient credits", "m:paid"),
      user: makeUser({ planTier: "pro" }), ...baseOpts,
    });
    expect(result).toBeNull();
  });

  it("Groq's key is revoked/invalid (401) -> degrades cleanly, no throw, no hang, original error still surfaces", async () => {
    // A real, worth-taking-seriously dependency risk: Groq's own free-tier
    // terms could change, or this key could be revoked/rotated externally,
    // with no warning. This proves the FAILURE MODE is safe even though the
    // underlying business risk (no contract, no SLA) isn't something code
    // can eliminate — a revoked key must degrade to "the original OpenRouter
    // error, unchanged", never crash the request or hang it.
    const fastify = withKey(makeFastify(makeState({ groqAdmitResult: "ok" })));
    mockFetchOnce({ ok: false, status: 401, text: "Invalid API Key" });
    const result = await attemptGroqFallback({
      fastify, triggeringError: new OpenRouterError("stream", 402, "insufficient credits", "m:paid"),
      user: makeUser({ planTier: "pro" }), ...baseOpts,
    });
    expect(result).toBeNull();
  });

  it("a transport-level failure (Groq unreachable entirely — DNS, timeout) also degrades cleanly, not just an HTTP error status", async () => {
    const fastify = withKey(makeFastify(makeState({ groqAdmitResult: "ok" })));
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const result = await attemptGroqFallback({
      fastify, triggeringError: new OpenRouterError("stream", 402, "insufficient credits", "m:paid"),
      user: makeUser({ planTier: "pro" }), ...baseOpts,
    });
    expect(result).toBeNull();
  });
});
