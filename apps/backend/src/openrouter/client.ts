import type { FastifyInstance } from "fastify";
import type { OpenRouterUsage } from "../types/index.js";

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessageParam {
  role: "system" | "user" | "assistant";
  // Plain string for every text-only call (the overwhelming majority).
  // ChatContentPart[] only when a vision-capable message needs to attach an
  // image alongside text — OpenAI-compatible multimodal format, proxied
  // through as-is by OpenRouter.
  content: string | ChatContentPart[];
}

interface OpenRouterStreamChunk {
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
  usage?: OpenRouterUsage;
}

export interface StreamCompletionOptions {
  fastify: FastifyInstance;
  model: string;
  messages: ChatMessageParam[];
  signal?: AbortSignal;
  onToken: (delta: string) => void;
}

export interface StreamCompletionResult {
  fullText: string;
  usage: OpenRouterUsage | null;
  aborted: boolean;
}

function openRouterHeaders(fastify: FastifyInstance): Record<string, string> {
  return {
    Authorization: `Bearer ${fastify.config.OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
    "HTTP-Referer": fastify.config.OPENROUTER_SITE_URL,
    "X-Title": fastify.config.OPENROUTER_APP_NAME,
  };
}

// Streams a completion from OpenRouter, invoking onToken for each delta as
// it arrives. Never streamed directly to the client 1:1 without going
// through the caller's SSE writer — callers own the client-facing framing.
export async function streamCompletion(opts: StreamCompletionOptions): Promise<StreamCompletionResult> {
  const { fastify, model, messages, signal, onToken } = opts;

  const response = await fetch(`${fastify.config.OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: openRouterHeaders(fastify),
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal,
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenRouter request failed (${response.status}): ${text.slice(0, 500)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let usage: OpenRouterUsage | null = null;
  let aborted = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const line = frame.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice("data:".length).trim();
        if (payload === "[DONE]") continue;

        let parsed: OpenRouterStreamChunk;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }

        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          onToken(delta);
        }
        if (parsed.usage) {
          usage = parsed.usage;
        }
      }
    }
  } catch (err) {
    if (signal?.aborted) {
      aborted = true;
    } else {
      throw err;
    }
  }

  return { fullText, usage, aborted };
}

export interface CompleteOnceResult {
  content: string;
  usage: OpenRouterUsage | null;
}

// Single non-streaming completion — used for structured JSON extraction
// calls (Cortex fallback classifier, memory extraction, workflow planning
// and non-final workflow steps), never for the user-facing streamed
// response. Returns usage since some callers (workflow steps) bill real
// generation against it; callers that don't care (classifier, memory) just
// ignore the field.
export async function completeOnce(opts: {
  fastify: FastifyInstance;
  model: string;
  messages: ChatMessageParam[];
  maxTokens?: number;
}): Promise<CompleteOnceResult> {
  const { fastify, model, messages, maxTokens = 200 } = opts;

  const response = await fetch(`${fastify.config.OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: openRouterHeaders(fastify),
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      temperature: 0,
      max_tokens: maxTokens,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenRouter classifier request failed (${response.status}): ${text.slice(0, 500)}`);
  }

  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: OpenRouterUsage;
  };
  return { content: json.choices?.[0]?.message?.content ?? "", usage: json.usage ?? null };
}

// Both streamCompletion and completeOnce throw with this exact "...failed
// (STATUS)..." shape only from their initial response.ok check — i.e.
// before any tokens have been sent to the client (streamCompletion's
// onToken calls only start after that check passes). That's what makes a
// retry-with-a-different-model safe here: there's never partial output on
// the wire yet. 429 is OpenRouter's shared-:free-pool rate limit (the
// dominant real-world case); 5xx covers a transient upstream outage.
export function isRetryableOpenRouterError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /OpenRouter (request|classifier request) failed \((429|5\d\d)\)/.test(err.message);
}
