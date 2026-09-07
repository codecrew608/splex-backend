import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeState, makeFastify } from "./helpers/fakeFastify.js";
import { recordGroqDispatchSuccess, recordGroqDispatchFailure } from "../src/groq/health.js";
import { streamGroqCompletion } from "../src/groq/client.js";

// Migration 0058 — Groq dispatch RELIABILITY tracking, distinct from
// CAPACITY tracking (migration 0056/0057). The concrete, buildable
// mitigation for the fact that Groq's free developer tier carries no
// contract or SLA: code cannot make that guarantee exist, but it can make
// sure a real degradation is caught from a log/dashboard, not from users
// complaining first. See groq/health.ts's own header for the full
// rationale.

const read = (rel: string) => readFileSync(join(import.meta.dirname, "..", "src", rel), "utf8");

describe("recordGroqDispatchSuccess / recordGroqDispatchFailure — basic wiring", () => {
  it("success normalizes 'free' planTier to tier: 'free'", async () => {
    const state = makeState();
    const fastify = makeFastify(state);
    recordGroqDispatchSuccess(fastify, "free");
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget microtask settle
    const call = state.rpcCalls.find((c) => c.name === "record_groq_dispatch_outcome");
    expect(call).toBeDefined();
    expect(call!.params).toMatchObject({ p_tier: "free", p_success: true });
  });

  it("success normalizes any non-'free' planTier ('pro', 'starter', ...) to tier: 'paid'", async () => {
    const state = makeState();
    const fastify = makeFastify(state);
    recordGroqDispatchSuccess(fastify, "pro");
    await new Promise((r) => setTimeout(r, 0));
    const call = state.rpcCalls.find((c) => c.name === "record_groq_dispatch_outcome");
    expect(call!.params.p_tier).toBe("paid");
  });

  it("failure passes the real status and a truncated body", async () => {
    const state = makeState();
    const fastify = makeFastify(state);
    recordGroqDispatchFailure(fastify, "free", 500, "x".repeat(1000));
    await new Promise((r) => setTimeout(r, 0));
    const call = state.rpcCalls.find((c) => c.name === "record_groq_dispatch_outcome");
    expect(call!.params).toMatchObject({ p_tier: "free", p_success: false, p_status: 500 });
    expect((call!.params.p_body as string).length).toBeLessThanOrEqual(500);
  });
});

function sseStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
    `data: [DONE]\n\n`,
  ];
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < frames.length) controller.enqueue(encoder.encode(frames[i++]));
      else controller.close();
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamGroqCompletion — records outcomes at the right points", () => {
  it("a successful stream records ONE success, zero failures", async () => {
    const state = makeState({ groqAdmitResult: "ok" });
    const fastify = makeFastify(state);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, body: sseStream("hi") })));

    await streamGroqCompletion({
      fastify, model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "hi" }],
      onToken: () => {}, maxTokens: 10, userId: "u1", planTier: "free",
    });
    await new Promise((r) => setTimeout(r, 0));

    const calls = state.rpcCalls.filter((c) => c.name === "record_groq_dispatch_outcome");
    expect(calls).toHaveLength(1);
    expect(calls[0].params.p_success).toBe(true);
  });

  it("a live HTTP failure (e.g. 429/500) records ONE failure with the real status", async () => {
    const state = makeState({ groqAdmitResult: "ok" });
    const fastify = makeFastify(state);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, body: null, text: async () => "server error" })));

    await expect(
      streamGroqCompletion({
        fastify, model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "hi" }],
        onToken: () => {}, maxTokens: 10, userId: "u1", planTier: "pro",
      }),
    ).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 0));

    const calls = state.rpcCalls.filter((c) => c.name === "record_groq_dispatch_outcome");
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toMatchObject({ p_tier: "paid", p_success: false, p_status: 500 });
  });

  it("an admission DENIAL (fair-share / capacity) records NOTHING here — that's SPLEX's own ceiling, not a Groq reliability signal", async () => {
    const state = makeState({ groqAdmitResult: "fair_share_exceeded" });
    const fastify = makeFastify(state);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      streamGroqCompletion({
        fastify, model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "hi" }],
        onToken: () => {}, maxTokens: 10, userId: "u1", planTier: "free",
      }),
    ).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).not.toHaveBeenCalled(); // never even reached the network
    const calls = state.rpcCalls.filter((c) => c.name === "record_groq_dispatch_outcome");
    expect(calls).toHaveLength(0);
  });
});

describe("groq/client.ts — structural pin: recordGroqDispatchFailure never wraps admitGroqFallbackRequest", () => {
  it("the failure-recording calls appear strictly AFTER admitGroqFallbackRequest in source order", () => {
    const src = read("groq/client.ts");
    const fnStart = src.indexOf("export async function streamGroqCompletion(");
    const admitAt = src.indexOf("admitGroqFallbackRequest(", fnStart);
    const firstFailureAt = src.indexOf("recordGroqDispatchFailure(", fnStart);
    expect(admitAt).toBeGreaterThan(-1);
    expect(firstFailureAt).toBeGreaterThan(admitAt);
  });
});
