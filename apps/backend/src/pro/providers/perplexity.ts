import type { FastifyInstance } from "fastify";
import { computeCostUsd, supportsFactory, unconnectedProvider, type AIProvider, type ProviderCapabilities, type ProviderCallParams, type ProviderCallResult } from "../providerCore.js";
import { callOpenAICompatible } from "./httpCompatible.js";

// Role default (item 3): the ONLY provider in this registry assigned
// "research" — its models search the live web as part of generating a
// response, which none of the other 4 do. buildTaskExecutionGraph's
// research phase (orchestrator.ts) is designed to land here via
// selectProviderFor's capability filter, not a hard-coded name check.
export const PERPLEXITY_CAPABILITIES: ProviderCapabilities = {
  operations: ["research"],
  modalities: ["text"],
  toolSupport: false,
  maxContextTokens: 128000,
  costPerMillionInputUsd: 1,
  costPerMillionOutputUsd: 1,
};

const TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 4096;

// Routed through OpenRouter using "API 2" (OPENROUTER_API_KEY_2) — see
// openai.ts's identical comment for the full isolation rationale (same
// credential, same rule, every Pro provider).
export function createPerplexityProvider(fastify: FastifyInstance): AIProvider {
  const apiKey = fastify.config.OPENROUTER_API_KEY_2;
  if (!apiKey) return unconnectedProvider("perplexity", PERPLEXITY_CAPABILITIES);

  return {
    name: "perplexity",
    capabilities: PERPLEXITY_CAPABILITIES,
    supports: supportsFactory(PERPLEXITY_CAPABILITIES),
    async call(params: ProviderCallParams): Promise<ProviderCallResult> {
      const startedAt = Date.now();
      const { content, inputTokens, outputTokens } = await callOpenAICompatible(
        { provider: "perplexity", baseUrl: fastify.config.OPENROUTER_BASE_URL, apiKey, model: fastify.config.PERPLEXITY_MODEL_ID, timeoutMs: TIMEOUT_MS },
        params.input,
        params.maxTokens ?? DEFAULT_MAX_TOKENS,
        params.signal,
      );
      return {
        content,
        model: fastify.config.PERPLEXITY_MODEL_ID,
        inputTokens,
        outputTokens,
        costUsd: computeCostUsd(PERPLEXITY_CAPABILITIES, inputTokens, outputTokens),
        latencyMs: Date.now() - startedAt,
      };
    },
  };
}
