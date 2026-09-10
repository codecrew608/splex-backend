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
// Anthropic's Messages API — structurally different from the OpenAI-
// compatible shape (httpCompatible.ts): x-api-key instead of a Bearer
// token, a required anthropic-version header, max_tokens is a REQUIRED
// body field (not optional the way OpenAI's is), and the response's text
// lives in a `content` array of typed blocks rather than
// choices[0].message.content. Not a fit for the shared helper.
const BASE_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
}

function classifyStatus(status: number): ProviderFailureClass {
  if (status === 401 || status === 403) return "auth_failure";
  if (status === 429) return "rate_limit";
  if (status === 400 || status === 422) return "invalid_request";
  if (status >= 500) return "temporary";
  return "application_bug";
}

export function createAnthropicProvider(fastify: FastifyInstance): AIProvider {
  const apiKey = fastify.config.ANTHROPIC_API_KEY;
  if (!apiKey) return unconnectedProvider("anthropic", ANTHROPIC_CAPABILITIES);

  return {
    name: "anthropic",
    capabilities: ANTHROPIC_CAPABILITIES,
    supports: supportsFactory(ANTHROPIC_CAPABILITIES),
    async call(params: ProviderCallParams): Promise<ProviderCallResult> {
      const startedAt = Date.now();
      const response = await fetch(BASE_URL, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: fastify.config.ANTHROPIC_MODEL_ID,
          max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
          messages: [{ role: "user", content: params.input }],
        }),
        signal: withDeadline(params.signal, TIMEOUT_MS),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new ProviderCallError("anthropic", classifyStatus(response.status), `anthropic request failed (${response.status}): ${text.slice(0, 500)}`);
      }

      let data: AnthropicResponse;
      try {
        data = (await response.json()) as AnthropicResponse;
      } catch (err) {
        throw new ProviderCallError("anthropic", "temporary", `anthropic returned an unparseable response: ${String(err)}`);
      }

      const content = data.content?.find((block) => block.type === "text")?.text ?? "";
      if (!content) {
        throw new ProviderCallError("anthropic", "temporary", "anthropic returned no text content");
      }

      const inputTokens = data.usage?.input_tokens ?? 0;
      const outputTokens = data.usage?.output_tokens ?? 0;
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
