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
// Real adapters (pro/providers/*.ts) — each checks its OWN API key
// (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, PERPLEXITY_API_KEY,
// XAI_API_KEY) at construction time via fastify.config: absent -> the
// same honest "no credential configured" stub this codebase has used
// since before any real adapter existed (providerCore.ts's
// unconnectedProvider); present -> a real HTTP call to that provider.
// Verified by grep before this was written: no such key exists anywhere
// in this codebase or its deployed secrets today, so defaultProviderRegistry
// below constructs 5 stubs in production right now, identically to before
// this file changed — activating a real adapter is a matter of setting
// one secret, never a further code change.
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
