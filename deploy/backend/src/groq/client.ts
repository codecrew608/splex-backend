import type { FastifyInstance } from "fastify";
import type { PlanTier } from "../shared-types.js";
import type { OpenRouterUsage } from "../types/index.js";
import type { ChatMessageParam, StreamCompletionResult } from "../openrouter/client.js";
import { withDeadline } from "../openrouter/client.js";
import { admitGroqFallbackRequest } from "./capacity.js";
import { recordGroqDispatchSuccess, recordGroqDispatchFailure } from "./health.js";

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

// 429 (rolling rate-limit window) / 5xx (transient upstream). Deliberately
// narrow, and restricted to this codebase's one Groq call site: there is no
// multi-candidate Groq fallback chain to retry across (see groq/fallback.ts
// — exactly one attempt, ever, per turn), so this exists purely to classify
// a failure for logging and reliability telemetry, never to decide whether
// to try again and — since 2026-09-07 — never to drive any capacity
// marking. See groq/capacity.ts's removal note for why a Groq 429 must not
// be treated the way an OpenRouter 429 legitimately is.
export function isRetryableGroqError(err: unknown): boolean {
  if (!(err instanceof GroqError)) return false;
  return /^(429|5\d\d)$/.test(String(err.status));
}

export function isGroqRateLimitError(err: unknown): boolean {
  return err instanceof GroqError && err.status === 429;
}

const GROQ_TIMEOUT_MS = 180_000;
// Sized to Groq's measured token-window reset (577ms) with headroom, and
// hard-capped so an unexpectedly large retry-after can never stall a
// user-facing turn — at that point failing fast and letting the caller
// surface an honest "busy, try shortly" beats holding the connection.
const GROQ_RETRY_MS = 1_500;
const GROQ_RETRY_MAX_MS = 4_000;

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

  const dispatch = () =>
    fetch(`${fastify.config.GROQ_BASE_URL}/chat/completions`, {
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

  let response = await dispatch();

  // ONE short retry on a 429, because Groq's rate-limit windows are
  // genuinely sub-second — measured on this account:
  //     x-ratelimit-reset-tokens:   577ms   (8,000 tokens/minute)
  //     x-ratelimit-reset-requests: 1m26s   (1,000 requests)
  //
  // FOUND LIVE (2026-09-07): a user working through long maths answers
  // exhausted the TOKENS-per-minute window — those replies are 2-4k tokens
  // each — and was told "You've reached today's limit for instant replies.
  // Please try again tomorrow." They were at 7 of 50 messages and 115 of
  // 3,000 credits. The limit they actually hit would have cleared before
  // they finished reading the sentence.
  //
  // Retrying once, briefly, converts most of those into a served answer.
  // Deliberately ONE retry with a small cap: the point is to ride out a
  // sub-second token window, not to sit in a retry loop against a provider
  // that is genuinely saturated. Honours Groq's own retry-after when it
  // sends one, and the caller's abort signal throughout.
  if (response.status === 429) {
    const retryAfterHeader = Number(response.headers?.get?.("retry-after") ?? NaN);
    const waitMs = Math.min(Number.isFinite(retryAfterHeader) ? retryAfterHeader * 1000 : GROQ_RETRY_MS, GROQ_RETRY_MAX_MS);
    fastify.log.warn(
      { model, planTier, waitMs },
      "Groq 429 (rolling window) — retrying once after a short wait rather than failing the turn",
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    if (!signal?.aborted) {
      response = await dispatch();
    }
  }

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    const err = new GroqError(response.status, text, model);
    if (isGroqRateLimitError(err)) {
      // Only logged — never a day-long exhaustion marking. See
      // groq/capacity.ts's removal note: treating a rolling-window 429 as
      // daily exhaustion took the whole fallback offline for every user.
      fastify.log.warn(
        { model, planTier, status: response.status },
        "Groq rate limit persisted through the retry — surfacing as a transient failure",
      );
    }
    // Reliability tracking (migration 0058) — deliberately recorded here,
    // AFTER admission already passed, not wrapping admitGroqFallbackRequest
    // above: a fair-share/capacity DENIAL is SPLEX's own configured ceiling
    // being hit, which says nothing about Groq's own reliability and must
    // not be conflated with it. Only a real dispatch attempt against Groq's
    // actual API — this branch, and the mid-stream one below — counts.
    recordGroqDispatchFailure(fastify, planTier, response.status, text);
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
      // A genuine mid-stream transport failure (connection dropped,
      // decode error) — distinct from a client abort (handled above, and
      // NOT a Groq reliability signal: Groq was serving fine, the client
      // walked away) and distinct from the initial !response.ok branch
      // (which already has a real HTTP status). No status code applies
      // here, so 0 is used as an explicit "transport-level, not an HTTP
      // response" marker rather than inventing one.
      recordGroqDispatchFailure(fastify, planTier, 0, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  // Reached only on a genuine successful completion OR a client-side abort
  // (Groq itself served correctly either way — see the catch block above
  // for why an abort is not counted as a Groq failure).
  recordGroqDispatchSuccess(fastify, planTier);

  return { fullText, usage, aborted };
}
