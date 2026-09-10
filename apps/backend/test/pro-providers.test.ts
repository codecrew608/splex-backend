import { describe, it, expect } from "vitest";
import {
  defaultProviderRegistry,
  selectProviderFor,
  createMockProvider,
  OPENAI_PROVIDER,
  ANTHROPIC_PROVIDER,
  GEMINI_PROVIDER,
  PERPLEXITY_PROVIDER,
  XAI_PROVIDER,
  ProviderCallError,
} from "../src/pro/providers.js";

describe("real provider stubs — honest about not being connected", () => {
  it("every real provider throws ProviderCallError on call(), never silently 'succeeds'", async () => {
    for (const provider of [OPENAI_PROVIDER, ANTHROPIC_PROVIDER, GEMINI_PROVIDER, PERPLEXITY_PROVIDER, XAI_PROVIDER]) {
      await expect(provider.call({ operation: provider.capabilities.operations[0], input: "x" }))
        .rejects.toBeInstanceOf(ProviderCallError);
    }
  });

  it("each declares only the operations item 3 assigns it as a default role — metadata, not a hard dispatch table", () => {
    expect(OPENAI_PROVIDER.capabilities.operations).toEqual(expect.arrayContaining(["plan", "reason"]));
    expect(ANTHROPIC_PROVIDER.capabilities.operations).toEqual(expect.arrayContaining(["code", "review"]));
    expect(GEMINI_PROVIDER.capabilities.operations).toEqual(expect.arrayContaining(["analyze", "review"]));
    expect(PERPLEXITY_PROVIDER.capabilities.operations).toEqual(["research"]);
    expect(XAI_PROVIDER.capabilities.operations).toEqual(expect.arrayContaining(["reason", "review"]));
  });

  it("supports() agrees with the declared operations list, for every provider", () => {
    for (const provider of [OPENAI_PROVIDER, ANTHROPIC_PROVIDER, GEMINI_PROVIDER, PERPLEXITY_PROVIDER, XAI_PROVIDER]) {
      expect(provider.supports("plan")).toBe(provider.capabilities.operations.includes("plan"));
      expect(provider.supports("code")).toBe(provider.capabilities.operations.includes("code"));
    }
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
    const registry = defaultProviderRegistry();
    const picked = selectProviderFor("research", registry);
    expect(picked?.name).toBe("perplexity"); // the only stub declaring 'research'
  });

  it("returns null when nothing in the registry supports the operation", () => {
    const onlyResearch = [PERPLEXITY_PROVIDER];
    expect(selectProviderFor("code", onlyResearch)).toBeNull();
  });

  it("among multiple capable providers, picks the cheapest by output cost — never blindly 'most expensive' or 'most capable'", () => {
    const registry = defaultProviderRegistry();
    // 'reason' is supported by openai, anthropic, gemini, xai — gemini is
    // the cheapest of those by costPerMillionOutputUsd (5 vs 6/10/15).
    const picked = selectProviderFor("reason", registry);
    expect(picked?.name).toBe("gemini");
  });
});
