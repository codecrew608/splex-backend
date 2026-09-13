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

// Role default (item 3): Anthropic as the primary coding/review system —
// distinct capability set from OpenAI's, so selectProviderFor's
// capability filter (never a hard-coded name check) is what actually
// routes "code"/"review" operations here.
export const ANTHROPIC_CAPABILITIES: ProviderCapabilities = {
  operations: ["code", "review", "generate", "reason", "tool_call"],
  modalities: ["text", "vision"],
  toolSupport: true,
  maxContextTokens: 200000,
  costPerMillionInputUsd: 3,
  costPerMillionOutputUsd: 15,
};

const TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 4096;

// Routed through OpenRouter using "API 2" (OPENROUTER_API_KEY_2) — NOT
// Anthropic's own Messages API (migrated 2026-09-13). OpenRouter presents
// a single OpenAI-compatible /chat/completions endpoint for every model it
// serves, Anthropic's included, so this now shares httpCompatible.ts's
// caller with every other Pro provider instead of Anthropic's own
// x-api-key/anthropic-version/content-array wire format — a real
// simplification, not just a credential swap. See openai.ts's identical
// comment for the full isolation rationale (same credential, same rule,
// every Pro provider).
export function createAnthropicProvider(fastify: FastifyInstance): AIProvider {
  const apiKey = fastify.config.OPENROUTER_API_KEY_2;
  if (!apiKey) return unconnectedProvider("anthropic", ANTHROPIC_CAPABILITIES);

  return {
    name: "anthropic",
    capabilities: ANTHROPIC_CAPABILITIES,
    supports: supportsFactory(ANTHROPIC_CAPABILITIES),
    async call(params: ProviderCallParams): Promise<ProviderCallResult> {
      const startedAt = Date.now();
      const { content, inputTokens, outputTokens } = await callOpenAICompatible(
        { provider: "anthropic", baseUrl: fastify.config.OPENROUTER_BASE_URL, apiKey, model: fastify.config.ANTHROPIC_MODEL_ID, timeoutMs: TIMEOUT_MS },
        params.input,
        params.maxTokens ?? DEFAULT_MAX_TOKENS,
        params.signal,
      );
      return {
        content,
        model: fastify.config.ANTHROPIC_MODEL_ID,
        inputTokens,
        outputTokens,
        costUsd: computeCostUsd(ANTHROPIC_CAPABILITIES, inputTokens, outputTokens),
        latencyMs: Date.now() - startedAt,
      };
    },
  };
}
