import type { FastifyInstance } from "fastify";
import { withDeadline } from "../../openrouter/client.js";
import {
  ProviderCallError,
  computeCostUsd,
  supportsFactory,
  unconnectedProvider,
  type AIProvider,
  type ProviderCapabilities,
  type ProviderCallParams,
  type ProviderCallResult,
  type ProviderFailureClass,
} from "../providerCore.js";

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

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { code?: number; message?: string; status?: string };
}

function classifyStatus(status: number): ProviderFailureClass {
  if (status === 401 || status === 403) return "auth_failure";
  if (status === 429) return "rate_limit";
  if (status === 400) return "invalid_request";
  if (status >= 500) return "temporary";
  return "application_bug";
}

export function createGeminiProvider(fastify: FastifyInstance): AIProvider {
  const apiKey = fastify.config.GEMINI_API_KEY;
  if (!apiKey) return unconnectedProvider("gemini", GEMINI_CAPABILITIES);

  return {
    name: "gemini",
    capabilities: GEMINI_CAPABILITIES,
    supports: supportsFactory(GEMINI_CAPABILITIES),
    async call(params: ProviderCallParams): Promise<ProviderCallResult> {
      const startedAt = Date.now();
      const model = fastify.config.GEMINI_MODEL_ID;
      // Google's direct-API-key auth for Gemini is a query parameter, not
      // a header — this codebase's other 4 providers all use header auth,
      // so this is a genuine, documented difference, not an oversight.
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: params.input }] }],
          generationConfig: { maxOutputTokens: params.maxTokens ?? DEFAULT_MAX_TOKENS },
        }),
        signal: withDeadline(params.signal, TIMEOUT_MS),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new ProviderCallError("gemini", classifyStatus(response.status), `gemini request failed (${response.status}): ${text.slice(0, 500)}`);
      }

      let data: GeminiResponse;
      try {
        data = (await response.json()) as GeminiResponse;
      } catch (err) {
        throw new ProviderCallError("gemini", "temporary", `gemini returned an unparseable response: ${String(err)}`);
      }

      const content = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      if (!content) {
        throw new ProviderCallError("gemini", "temporary", "gemini returned no content");
      }

      const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
      const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
      return {
        content,
        model,
        inputTokens,
        outputTokens,
        costUsd: computeCostUsd(GEMINI_CAPABILITIES, inputTokens, outputTokens),
        latencyMs: Date.now() - startedAt,
      };
    },
  };
}
