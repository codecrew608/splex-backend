import { withDeadline } from "../../openrouter/client.js";
import { ProviderCallError, type ProviderFailureClass, type ProviderName } from "../providerCore.js";

// Shared caller for the 3 providers whose chat-completions API is
// OpenAI-compatible in both request and response shape (OpenAI itself,
// Perplexity, xAI) — same request body, same response body, same error
// envelope. Writing this once and having openai.ts/perplexity.ts/xai.ts
// each supply only their base URL, key, and model keeps 3 real HTTP
// integrations from becoming 3 near-identical copies of the same ~80
// lines, which is exactly the kind of duplication the master prompt's
// own "reuse, don't duplicate a subsystem" principle (already applied at
// the schema level in migration 0061) applies to at the code level too.

export interface OpenAICompatibleConfig {
  provider: ProviderName;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

interface ChatCompletionsResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

// HTTP status -> ProviderFailureClass. Every provider on this shared path
// uses the same convention (they're all effectively OpenAI's own API
// contract, including their status-code semantics), so one mapping
// covers all three — a provider-specific override would only be
// justified by an observed real difference, which none of these three
// have from their own documentation.
function classifyHttpStatus(status: number): ProviderFailureClass {
  if (status === 401 || status === 403) return "auth_failure";
  if (status === 429) return "rate_limit";
  if (status === 402) return "capacity_exhausted";
  if (status === 400 || status === 422) return "invalid_request";
  if (status >= 500) return "temporary";
  return "application_bug";
}

export async function callOpenAICompatible(
  config: OpenAICompatibleConfig,
  input: string,
  maxTokens: number,
  signal: AbortSignal | undefined,
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: "user", content: input }],
      max_tokens: maxTokens,
    }),
    signal: withDeadline(signal, config.timeoutMs),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new ProviderCallError(
      config.provider,
      classifyHttpStatus(response.status),
      `${config.provider} request failed (${response.status}): ${text.slice(0, 500)}`,
    );
  }

  let data: ChatCompletionsResponse;
  try {
    data = (await response.json()) as ChatCompletionsResponse;
  } catch (err) {
    throw new ProviderCallError(config.provider, "temporary", `${config.provider} returned an unparseable response: ${String(err)}`);
  }

  const content = data.choices?.[0]?.message?.content ?? "";
  if (!content) {
    throw new ProviderCallError(config.provider, "temporary", `${config.provider} returned no content`);
  }

  return {
    content,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };
}
