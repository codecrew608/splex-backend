import type { FastifyInstance } from "fastify";
import { computeCostUsd, supportsFactory, unconnectedProvider, type AIProvider, type ProviderCapabilities, type ProviderCallParams, type ProviderCallResult } from "../providerCore.js";
import { callOpenAICompatible } from "./httpCompatible.js";

export const XAI_CAPABILITIES: ProviderCapabilities = {
  operations: ["reason", "review", "analyze", "tool_call"],
  modalities: ["text"],
  toolSupport: true,
  maxContextTokens: 128000,
  costPerMillionInputUsd: 2,
  costPerMillionOutputUsd: 6,
};

const TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 4096;
const BASE_URL = "https://api.x.ai/v1";

export function createXAIProvider(fastify: FastifyInstance): AIProvider {
  const apiKey = fastify.config.XAI_API_KEY;
  if (!apiKey) return unconnectedProvider("xai", XAI_CAPABILITIES);

  return {
    name: "xai",
    capabilities: XAI_CAPABILITIES,
    supports: supportsFactory(XAI_CAPABILITIES),
    async call(params: ProviderCallParams): Promise<ProviderCallResult> {
      const startedAt = Date.now();
      const { content, inputTokens, outputTokens } = await callOpenAICompatible(
        { provider: "xai", baseUrl: BASE_URL, apiKey, model: fastify.config.XAI_MODEL_ID, timeoutMs: TIMEOUT_MS },
        params.input,
        params.maxTokens ?? DEFAULT_MAX_TOKENS,
        params.signal,
      );
      return {
        content,
        model: fastify.config.XAI_MODEL_ID,
        inputTokens,
        outputTokens,
        costUsd: computeCostUsd(XAI_CAPABILITIES, inputTokens, outputTokens),
        latencyMs: Date.now() - startedAt,
      };
    },
  };
}
