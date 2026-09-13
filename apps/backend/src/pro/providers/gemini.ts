import type { FastifyInstance } from "fastify";
import {
  computeCostUsd,
  supportsFactory,
  unconnectedProvider,
  type AIProvider,
  type ProviderCapabilities,
  type ProviderCallParams,
  type ProviderCallResult,
} from "../providerCore.js";
import { callOpenAICompatible } from "./httpCompatible.js";

// Role default (item 3): Gemini as the primary analysis/review system —
// the largest context window of the 5 (1M tokens), which is WHY
// buildTaskExecutionGraph's analyze-heavy phases (requirements,
// verification) are capability-matched to land here via selectProviderFor,
// never a hard-coded name check.
export const GEMINI_CAPABILITIES: ProviderCapabilities = {
  operations: ["analyze", "review", "reason", "generate"],
  modalities: ["text", "vision", "audio"],
  toolSupport: true,
  maxContextTokens: 1000000,
  costPerMillionInputUsd: 1.25,
  costPerMillionOutputUsd: 5,
};

const TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 4096;

// Routed through OpenRouter using "API 2" (OPENROUTER_API_KEY_2) — NOT
// Google's direct Generative Language API (migrated 2026-09-13).
// OpenRouter presents a single OpenAI-compatible /chat/completions
// endpoint for every model it serves, Gemini's included, so this now
// shares httpCompatible.ts's caller with every other Pro provider instead
// of Gemini's own query-param-auth/candidates-array wire format — a real
// simplification, not just a credential swap. See openai.ts's identical
// comment for the full isolation rationale (same credential, same rule,
// every Pro provider).
export function createGeminiProvider(fastify: FastifyInstance): AIProvider {
  const apiKey = fastify.config.OPENROUTER_API_KEY_2;
  if (!apiKey) return unconnectedProvider("gemini", GEMINI_CAPABILITIES);

  return {
    name: "gemini",
    capabilities: GEMINI_CAPABILITIES,
    supports: supportsFactory(GEMINI_CAPABILITIES),
    async call(params: ProviderCallParams): Promise<ProviderCallResult> {
      const startedAt = Date.now();
      const { content, inputTokens, outputTokens } = await callOpenAICompatible(
        { provider: "gemini", baseUrl: fastify.config.OPENROUTER_BASE_URL, apiKey, model: fastify.config.GEMINI_MODEL_ID, timeoutMs: TIMEOUT_MS },
        params.input,
        params.maxTokens ?? DEFAULT_MAX_TOKENS,
        params.signal,
      );
      return {
        content,
        model: fastify.config.GEMINI_MODEL_ID,
        inputTokens,
        outputTokens,
        costUsd: computeCostUsd(GEMINI_CAPABILITIES, inputTokens, outputTokens),
        latencyMs: Date.now() - startedAt,
      };
    },
  };
}
