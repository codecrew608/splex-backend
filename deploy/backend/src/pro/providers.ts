import type { FastifyInstance } from "fastify";
import { createOpenAIProvider } from "./providers/openai.js";
import { createAnthropicProvider } from "./providers/anthropic.js";
import { createGeminiProvider } from "./providers/gemini.js";
import { createPerplexityProvider } from "./providers/perplexity.js";
import { createXAIProvider } from "./providers/xai.js";
import type { AIProvider, ProviderCapabilities, ProviderName, ProviderOperation } from "./providerCore.js";
import { supportsFactory } from "./providerCore.js";

// SPLEX Pro provider abstraction (item 4). One common interface every AI
// system implements; nothing outside this file and pro/providers/*.ts
// ever makes a provider-specific API call. The orchestrator selects a
// provider by CAPABILITY, never by name — role defaults are metadata the
// orchestrator consults, not a hard-coded dispatch table (item 3's own
// explicit requirement).
//
// Base types (AIProvider, ProviderCapabilities, ProviderCallError, ...)
// live in providerCore.ts and are re-exported below unchanged — split out
// specifically so this file can import the 5 real adapter factories
// (providers/openai.ts and siblings), which themselves need those base
// types, without a circular import between this file and them.
export type {
  ProviderName,
  ProviderOperation,
  ProviderCapabilities,
  ProviderCallParams,
  ProviderCallResult,
  ProviderFailureClass,
  AIProvider,
} from "./providerCore.js";
export { ProviderCallError, unconnectedProvider, supportsFactory, computeCostUsd } from "./providerCore.js";

// ---------------------------------------------------------------------
// Real adapters (pro/providers/*.ts) — ALL FIVE route through OpenRouter
// using ONE shared credential, fastify.config.OPENROUTER_API_KEY_2 ("API
// 2"), checked at construction time: absent -> the same honest "no
// credential configured" stub this codebase has used since before any
// real adapter existed (providerCore.ts's unconnectedProvider); present
// -> a real HTTP call, via OpenRouter, to that provider's model (see each
// providers/*.ts file's own OPENROUTER_*_MODEL_ID / *_MODEL_ID constant
// for exactly which model). This replaced 5 separate native provider keys
// (2026-09-13) — no such keys exist in this codebase's schema anymore.
//
// OPENROUTER_API_KEY_2 is a SEPARATE credential from OPENROUTER_API_KEY
// ("API 1", the ONLY key Free/Starter's openrouter/client.ts ever reads)
// — see test/free-starter-failover.test.ts for the isolation pins this
// depends on. Verified: OPENROUTER_API_KEY_2 is absent from this
// codebase's deployed secrets today, so defaultProviderRegistry below
// constructs 5 stubs in production right now — activating every real
// adapter at once is a matter of setting that one secret, never a
// further code change, and Pro stays unreachable regardless
// (SPLEX_PRO_ENABLED / system_flags.pro_enabled — see pro/gate.ts).
// ---------------------------------------------------------------------
export function defaultProviderRegistry(fastify: FastifyInstance): AIProvider[] {
  return [
    createOpenAIProvider(fastify),
    createAnthropicProvider(fastify),
    createGeminiProvider(fastify),
    createPerplexityProvider(fastify),
    createXAIProvider(fastify),
  ];
}

// ---------------------------------------------------------------------
// MockProvider — real, working, fully offline (item 38: "For testing
// orchestration logic, use mocks... deterministic fixtures... synthetic
// responses... offline simulation"). Every orchestrator test in this
// phase runs against this, never a real API. Deterministic on its input
// so a test asserting a specific output isn't flaky.
// ---------------------------------------------------------------------
export function createMockProvider(name: ProviderName = "mock"): AIProvider {
  const capabilities: ProviderCapabilities = {
    operations: ["plan", "reason", "generate", "analyze", "review", "research", "code", "tool_call"],
    modalities: ["text"],
    toolSupport: true,
    maxContextTokens: 128000,
    costPerMillionInputUsd: 0,
    costPerMillionOutputUsd: 0,
  };
  return {
    name,
    capabilities,
    supports: supportsFactory(capabilities),
    async call(params) {
      const inputTokens = Math.ceil(params.input.length / 4);
      const content = `[mock:${params.operation}] synthetic result for: ${params.input.slice(0, 80)}`;
      return {
        content,
        model: "mock-model",
        inputTokens,
        outputTokens: Math.ceil(content.length / 4),
        costUsd: 0,
        latencyMs: 1,
      };
    },
  };
}

// Ranks candidates for one operation by cost (item 24: "the cheapest model
// capable of doing the task well enough" — capability-filtered first, so
// "capable" is never traded away for "cheap"). Provider-agnostic: works
// identically whether the registry holds real adapters, stubs, or mocks.
export function selectProviderFor(operation: ProviderOperation, registry: AIProvider[]): AIProvider | null {
  const capable = registry.filter((p) => p.supports(operation));
  if (capable.length === 0) return null;
  capable.sort((a, b) => a.capabilities.costPerMillionOutputUsd - b.capabilities.costPerMillionOutputUsd);
  return capable[0];
}
