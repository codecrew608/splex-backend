import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

// ===========================================================================
// OPENROUTER_API_KEY_2 migration (2026-09-13) — all 5 real adapters now
// route through OpenRouter on the shared Pro-only credential, never their
// own native provider API (which no longer exists in this codebase at all).
// ===========================================================================

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const API_KEY_2 = "sk-or-v1-test-pro-credential";
const API_KEY_1 = "sk-or-v1-test-free-starter-credential"; // Free/Starter's OWN key — must never connect a Pro provider

function fakeFastifyConnected(overrides: Record<string, unknown> = {}) {
  return {
    config: {
      OPENROUTER_API_KEY_2: API_KEY_2,
      OPENROUTER_BASE_URL,
      OPENAI_MODEL_ID: "openai/gpt-5.6-luna",
      ANTHROPIC_MODEL_ID: "anthropic/claude-3-haiku",
      GEMINI_MODEL_ID: "google/gemini-2.5-flash-lite",
      PERPLEXITY_MODEL_ID: "perplexity/sonar",
      XAI_MODEL_ID: "x-ai/grok-build-0.1",
      ...overrides,
    },
  } as never;
}

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  const fn = vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const ADAPTERS: Array<{
  name: string;
  create: (fastify: ReturnType<typeof fakeFastifyConnected>) => ReturnType<typeof createOpenAIProvider>;
  model: string;
}> = [
  { name: "openai", create: createOpenAIProvider, model: "openai/gpt-5.6-luna" },
  { name: "anthropic", create: createAnthropicProvider, model: "anthropic/claude-3-haiku" },
  { name: "gemini", create: createGeminiProvider, model: "google/gemini-2.5-flash-lite" },
  { name: "perplexity", create: createPerplexityProvider, model: "perplexity/sonar" },
  { name: "xai", create: createXAIProvider, model: "x-ai/grok-build-0.1" },
];

describe("Pro providers — connected via OPENROUTER_API_KEY_2 (API 2)", () => {
  it.each(ADAPTERS)("$name constructs as CONNECTED (real name, not a stub) when OPENROUTER_API_KEY_2 is set", ({ create, name }) => {
    const fastify = fakeFastifyConnected();
    const provider = create(fastify);
    expect(provider.name).toBe(name);
    // A connected provider's call() reaches fetch (proven in the next
    // test); an unconnected stub throws synchronously before ever
    // touching the network — proven separately below.
  });

  it.each(ADAPTERS)("$name.call() sends Authorization: Bearer <OPENROUTER_API_KEY_2> to OPENROUTER_BASE_URL with model=$model", async ({ create, model }) => {
    const fastify = fakeFastifyConnected();
    const fetchMock = mockFetchOnce({ choices: [{ message: { content: "hello" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } });

    const provider = create(fastify);
    const result = await provider.call({ operation: provider.capabilities.operations[0], input: "hi" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY_2}`);
    expect((init.headers as Record<string, string>).Authorization).not.toContain(API_KEY_1);
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(model);
    expect(result.model).toBe(model); // telemetry/model-registry identity preserved
  });

  it.each(ADAPTERS)("$name falls back to the unconnected stub when OPENROUTER_API_KEY_2 is absent, even if OPENROUTER_API_KEY (API 1) IS set", async ({ create }) => {
    // The critical isolation case: Free/Starter's own credential being
    // configured must NEVER be enough to connect a Pro provider.
    const fastify = fakeFastifyConnected({ OPENROUTER_API_KEY_2: undefined, OPENROUTER_API_KEY: API_KEY_1 });
    const fetchMock = mockFetchOnce({});
    const provider = create(fastify);
    await expect(provider.call({ operation: provider.capabilities.operations[0], input: "x" })).rejects.toBeInstanceOf(ProviderCallError);
    expect(fetchMock).not.toHaveBeenCalled(); // never even attempted a network call
  });

  it("defaultProviderRegistry connects all 5 at once from the single shared credential", async () => {
    const fastify = fakeFastifyConnected();
    mockFetchOnce({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const registry = defaultProviderRegistry(fastify);
    for (const provider of registry) {
      await expect(provider.call({ operation: provider.capabilities.operations[0], input: "x" })).resolves.toBeTruthy();
    }
  });

  it("a failed OpenRouter call's error message never contains the API key value (no secret leakage to logs or users)", async () => {
    const fastify = fakeFastifyConnected();
    mockFetchOnce({ error: { message: "invalid credentials" } }, false, 401);
    const provider = createOpenAIProvider(fastify);
    try {
      await provider.call({ operation: "plan", input: "x" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderCallError);
      const message = (err as ProviderCallError).message;
      expect(message).not.toContain(API_KEY_2);
      expect(message).not.toContain(API_KEY_1);
    }
  });

  it("Pro media model ids (image/video/tts) are config-only — no execution path reads them yet, confirmed by source scan", () => {
    const executionSrc = readFileSync(join(import.meta.dirname, "..", "src", "pro", "execution.ts"), "utf8");
    expect(executionSrc).not.toMatch(/PRO_IMAGE_MODEL_ID|PRO_VIDEO_MODEL_ID|PRO_TTS_MODEL_ID/);
  });
});
