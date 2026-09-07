import type { FastifyInstance } from "fastify";
import type { PlanTier } from "../shared-types.js";
import type { OpenRouterUsage } from "../types/index.js";
import type { ChatMessageParam, StreamCompletionResult } from "../openrouter/client.js";
import { withDeadline } from "../openrouter/client.js";
import { admitGroqFallbackRequest, markGroqModelExhausted } from "./capacity.js";

// Groq (api.groq.com — Groq, Inc., the LPU fast-inference hardware
// company) — NOT xAI's Grok. See db/migrations/0056's header comment for
// how that was confirmed. Used ONLY as a Free-tier emergency fallback when
// OpenRouter's own free capacity is genuinely exhausted — see
// groq/fallback.ts for the eligibility gate. This client deliberately does
// NOT replicate SPLEX's category-aware model routing: it is one emergency
// valve with one curated fallback model (GROQ_FALLBACK_MODEL), not a
// second competing routing system.

export interface GroqStreamOptions {
  fastify: FastifyInstance;
  model: string;
  messages: ChatMessageParam[];
  signal?: AbortSignal;
  onToken: (delta: string) => void;
  userId: string;
  planTier: PlanTier;
  maxTokens: number;
}

interface GroqStreamChunk {
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
  usage?: OpenRouterUsage;
}

// Same enumerable-fields discipline as OpenRouterError (see that class's
// own doc comment for the "err: {}" production bug this pattern exists to
// prevent). No `kind` field — Groq has only one call shape in this
// codebase (the fallback stream), unlike OpenRouter's stream/classifier
// split.
export class GroqError extends Error {
  readonly status: number;
  readonly body: string;
  readonly model: string | null;

  constructor(status: number, body: string, model: string | null) {
    // Shape preserved deliberately close to OpenRouterError's own message
    // string so isRetryableGroqError's regex below stays simple and
    // consistent with its OpenRouter counterpart.
    super(`Groq fallback request failed (${status}): ${body.slice(0, 500)}`);
    this.name = "GroqError";
    this.status = status;
    this.body = body.slice(0, 500);
    this.model = model;
  }
}

export function describeGroqError(err: unknown): Record<string, unknown> {
  if (err instanceof GroqError) {
    return { errorName: err.name, errorMessage: err.message, status: err.status, providerBody: err.body, model: err.model };
  }
  if (err instanceof Error) {
    return { errorName: err.name, errorMessage: err.message, errorStack: err.stack?.slice(0, 600) };
  }
  return { errorName: typeof err, errorMessage: String(err) };
}

// 429/5xx — the shapes worth a reactive capacity-exhaustion mark (429) or
// are simply transient (5xx). Deliberately narrow, matching
// isRetryableOpenRouterError's own scope restricted to this codebase's one
// Groq call site: there is no multi-candidate Groq fallback chain to
// retry across (see groq/fallback.ts — exactly one attempt, ever, per
// turn), so this exists only to classify the failure for logging/telemetry
// and to drive markGroqModelExhausted, not to decide whether to try again.
export function isRetryableGroqError(err: unknown): boolean {
  if (!(err instanceof GroqError)) return false;
  return /^(429|5\d\d)$/.test(String(err.status));
}

export function isGroqRateLimitError(err: unknown): boolean {
  return err instanceof GroqError && err.status === 429;
}

const GROQ_TIMEOUT_MS = 180_000;

function groqHeaders(fastify: FastifyInstance): Record<string, string> {
  return {
    Authorization: `Bearer ${fastify.config.GROQ_API_KEY}`,
    "Content-Type": "application/json",
  };
}

// Streams a completion from Groq — same SSE parsing shape as
// openrouter/client.ts's streamCompletion (Groq's chat/completions
// endpoint is OpenAI-compatible), returning the IDENTICAL
// StreamCompletionResult shape so every downstream call site in
// handlers/chat.ts (computeRealCost, updateMessageResult, consumeCredits,
// the SSE routing summary) works unchanged regardless of which provider
// actually served the turn.
export async function streamGroqCompletion(opts: GroqStreamOptions): Promise<StreamCompletionResult> {
  const { fastify, model, messages, signal, onToken, maxTokens, userId, planTier } = opts;

  await admitGroqFallbackRequest(fastify, userId, planTier, model);

  const response = await fetch(`${fastify.config.GROQ_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: groqHeaders(fastify),
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: maxTokens,
    }),
    signal: withDeadline(signal, GROQ_TIMEOUT_MS),
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    const err = new GroqError(response.status, text, model);
    if (isGroqRateLimitError(err)) {
      // Reactive correction (migration 0056) — same reasoning as
      // markModelCapacityExhausted: a live 429 tells us the truth right
      // now, faster than the proactive daily counter could organically
      // reach it, and protects every other pending/future fallback attempt
      // today without an extra wasted round trip.
      markGroqModelExhausted(fastify, model);
    }
    throw err;
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

        let parsed: GroqStreamChunk;
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
