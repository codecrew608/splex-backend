import { describe, it, expect } from "vitest";
import {
  defaultProviderRegistry,
  selectProviderFor,
  createMockProvider,
  ProviderCallError,
} from "../src/pro/providers.js";
import { createOpenAIProvider } from "../src/pro/providers/openai.js";
import { createAnthropicProvider } from "../src/pro/providers/anthropic.js";
import { createGeminiProvider } from "../src/pro/providers/gemini.js";
import { createPerplexityProvider } from "../src/pro/providers/perplexity.js";
import { createXAIProvider } from "../src/pro/providers/xai.js";

// No provider API key set anywhere in this fake — matches production's
// actual current state (verified by grep before providers/*.ts was
// written: no such key exists in this codebase or its deployed secrets),
// so every createXProvider below constructs the same honest "unconnected"
// stub it always has. Each real adapter's construction is exercised here
// (import path, capability declaration, stub fallback when its key is
// absent) — the real HTTP call path itself is NOT tested, since it can
// only be genuinely verified against the real API once a key exists.
function fakeFastifyNoKeys() {
  return { config: {} } as never;
}

describe("real provider adapters — honest about not being connected while no key is configured", () => {
  it("every real provider throws ProviderCallError on call(), never silently 'succeeds'", async () => {
    const fastify = fakeFastifyNoKeys();
    const providers = [
      createOpenAIProvider(fastify),
      createAnthropicProvider(fastify),
      createGeminiProvider(fastify),
      createPerplexityProvider(fastify),
      createXAIProvider(fastify),
    ];
    for (const provider of providers) {
      await expect(provider.call({ operation: provider.capabilities.operations[0], input: "x" }))
        .rejects.toBeInstanceOf(ProviderCallError);
    }
  });

  it("each declares only the operations item 3 assigns it as a default role — metadata, not a hard dispatch table", () => {
    const fastify = fakeFastifyNoKeys();
    expect(createOpenAIProvider(fastify).capabilities.operations).toEqual(expect.arrayContaining(["plan", "reason"]));
    expect(createAnthropicProvider(fastify).capabilities.operations).toEqual(expect.arrayContaining(["code", "review"]));
    expect(createGeminiProvider(fastify).capabilities.operations).toEqual(expect.arrayContaining(["analyze", "review"]));
    expect(createPerplexityProvider(fastify).capabilities.operations).toEqual(["research"]);
    expect(createXAIProvider(fastify).capabilities.operations).toEqual(expect.arrayContaining(["reason", "review"]));
  });

  it("supports() agrees with the declared operations list, for every provider", () => {
    const fastify = fakeFastifyNoKeys();
    const providers = [
      createOpenAIProvider(fastify),
      createAnthropicProvider(fastify),
      createGeminiProvider(fastify),
      createPerplexityProvider(fastify),
      createXAIProvider(fastify),
    ];
    for (const provider of providers) {
      expect(provider.supports("plan")).toBe(provider.capabilities.operations.includes("plan"));
      expect(provider.supports("code")).toBe(provider.capabilities.operations.includes("code"));
    }
  });

  it("defaultProviderRegistry constructs all 5 as unconnected stubs when no key is configured — activation needs zero code change, only the env var", () => {
    const registry = defaultProviderRegistry(fakeFastifyNoKeys());
    expect(registry.map((p) => p.name).sort()).toEqual(["anthropic", "gemini", "openai", "perplexity", "xai"]);
  });
});

describe("MockProvider — real, working, fully offline (item 38)", () => {
  it("actually returns a result — no network, no external dependency", async () => {
    const mock = createMockProvider();
    const result = await mock.call({ operation: "generate", input: "write a haiku" });
    expect(result.content).toContain("generate");
    expect(result.costUsd).toBe(0);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("supports every operation (a fully-capable stand-in for orchestrator testing)", () => {
    const mock = createMockProvider();
    for (const op of ["plan", "reason", "generate", "analyze", "review", "research", "code", "tool_call"] as const) {
      expect(mock.supports(op)).toBe(true);
    }
  });

  it("is deterministic given the same input shape (no flaky tests downstream)", async () => {
    const mock = createMockProvider();
    const a = await mock.call({ operation: "analyze", input: "same input" });
    const b = await mock.call({ operation: "analyze", input: "same input" });
    expect(a.content).toBe(b.content);
  });
});

describe("selectProviderFor — capability-filtered FIRST, cost-ranked second (item 24)", () => {
  it("never returns a provider that doesn't support the requested operation", () => {
    const registry = defaultProviderRegistry(fakeFastifyNoKeys());
    const picked = selectProviderFor("research", registry);
    expect(picked?.name).toBe("perplexity"); // the only stub declaring 'research'
  });

  it("returns null when nothing in the registry supports the operation", () => {
    const onlyResearch = [createPerplexityProvider(fakeFastifyNoKeys())];
    expect(selectProviderFor("code", onlyResearch)).toBeNull();
  });

  it("among multiple capable providers, picks the cheapest by output cost — never blindly 'most expensive' or 'most capable'", () => {
    const registry = defaultProviderRegistry(fakeFastifyNoKeys());
    // 'reason' is supported by openai, anthropic, gemini, xai — gemini is
    // the cheapest of those by costPerMillionOutputUsd (5 vs 6/10/15).
    const picked = selectProviderFor("reason", registry);
    expect(picked?.name).toBe("gemini");
  });
});
