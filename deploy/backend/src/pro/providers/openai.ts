import type { FastifyInstance } from "fastify";
import { computeCostUsd, supportsFactory, unconnectedProvider, type AIProvider, type ProviderCapabilities, type ProviderCallParams, type ProviderCallResult } from "../providerCore.js";
import { callOpenAICompatible } from "./httpCompatible.js";

// Role default (item 3): OpenAI as a general planning/reasoning/generation
// system — not hard-coded dispatch, metadata the orchestrator ranks
// against every other provider's own declared operations.
export const OPENAI_CAPABILITIES: ProviderCapabilities = {
  operations: ["plan", "reason", "generate", "analyze"],
  modalities: ["text", "vision"],
  toolSupport: true,
  maxContextTokens: 128000,
  costPerMillionInputUsd: 2.5,
  costPerMillionOutputUsd: 10,
};

const TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 4096;

// Routed through OpenRouter using "API 2" (OPENROUTER_API_KEY_2) — a
// SEPARATE credential from Free/Starter's OPENROUTER_API_KEY ("API 1",
// openrouter/client.ts). This file never reads plain OPENROUTER_API_KEY,
// and Free/Starter code never reads _2 — see
// test/free-starter-failover.test.ts for the isolation pins this depends
// on. No native OpenAI API key exists in this codebase anymore (removed
// 2026-09-13 — see plugins/env.ts's own header for why a single shared
// OpenRouter credential replaced 5 separate provider keys).
export function createOpenAIProvider(fastify: FastifyInstance): AIProvider {
  const apiKey = fastify.config.OPENROUTER_API_KEY_2;
  if (!apiKey) return unconnectedProvider("openai", OPENAI_CAPABILITIES);

  return {
    name: "openai",
    capabilities: OPENAI_CAPABILITIES,
    supports: supportsFactory(OPENAI_CAPABILITIES),
    async call(params: ProviderCallParams): Promise<ProviderCallResult> {
      const startedAt = Date.now();
      const { content, inputTokens, outputTokens } = await callOpenAICompatible(
        { provider: "openai", baseUrl: fastify.config.OPENROUTER_BASE_URL, apiKey, model: fastify.config.OPENAI_MODEL_ID, timeoutMs: TIMEOUT_MS },
        params.input,
        params.maxTokens ?? DEFAULT_MAX_TOKENS,
        params.signal,
      );
      return {
        content,
        model: fastify.config.OPENAI_MODEL_ID,
        inputTokens,
        outputTokens,
        costUsd: computeCostUsd(OPENAI_CAPABILITIES, inputTokens, outputTokens),
        latencyMs: Date.now() - startedAt,
      };
    },
  };
}
