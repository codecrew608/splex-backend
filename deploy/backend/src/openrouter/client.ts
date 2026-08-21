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

export function openRouterHeaders(fastify: FastifyInstance): Record<string, string> {
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

// OpenRouter's server-side web tools (see
// https://openrouter.ai/blog/announcements/agentic-web-tools/) — the model
// decides if/when to call these, OpenRouter executes them and feeds
// results back into the SAME completion, and the tool-call loop happens
// entirely server-side. max_total_results is the hard, provider-enforced
// ceiling on search results across every call the model makes within one
// request — this (not client-side after-the-fact policing) is the real
// mechanism that bounds a runaway search loop.
export interface WebSearchTool {
  type: "openrouter:web_search";
  max_results?: number;
  max_total_results?: number;
  allowed_domains?: string[];
  excluded_domains?: string[];
}
export interface WebFetchTool {
  type: "openrouter:web_fetch";
  max_content_tokens?: number;
  allowed_domains?: string[];
  blocked_domains?: string[];
}
export type OpenRouterTool = WebSearchTool | WebFetchTool;

// One entry per URL the model actually grounded a claim in. Field names
// match OpenRouter's `message.annotations[].url_citation` shape exactly
// (url/title/content/start_index/end_index) so no translation layer is
// needed between the wire format and what research/ produces.
export interface UrlCitation {
  url: string;
  title: string;
  content: string;
  start_index: number;
  end_index: number;
}

export interface CompleteOnceResult {
  content: string;
  usage: OpenRouterUsage | null;
  // OpenRouter's own completion id (e.g. "gen-..."). Needed to resolve
  // real cost afterward via fetchGenerationCost for any call whose price
  // isn't pure token-rate math — web_search/web_fetch tool calls carry a
  // flat per-call cost on top of tokens, so this is how research/search.ts
  // gets the authoritative total rather than estimating it.
  generationId: string | null;
  citations: UrlCitation[];
}

// Single non-streaming completion — used for structured JSON extraction
// calls (Cortex fallback classifier, memory extraction, workflow planning
// and non-final workflow steps, web search, deep research's staged calls),
// never for the user-facing streamed response. Returns usage since some
// callers (workflow steps, research) bill real generation against it;
// callers that don't care (classifier, memory) just ignore the field.
export async function completeOnce(opts: {
  fastify: FastifyInstance;
  model: string;
  messages: ChatMessageParam[];
  maxTokens?: number;
  tools?: OpenRouterTool[];
}): Promise<CompleteOnceResult> {
  const { fastify, model, messages, maxTokens = 200, tools } = opts;

  const bodyFor = (disableReasoning: boolean) =>
    JSON.stringify({
      model,
      messages,
      stream: false,
      temperature: 0,
      max_tokens: maxTokens,
      // Every completeOnce caller (classifier fallback, memory extraction,
      // workflow planning/steps, web search, every deep research stage)
      // wants a direct, parseable/readable answer within maxTokens, not a
      // visible reasoning trace competing for the same token budget. Live
      // testing found this genuinely necessary, not cosmetic: on a
      // reasoning-capable model, a nontrivial prompt (deep research's
      // planning stage, breaking a question into sub-questions) can spend
      // an ENTIRE small maxTokens budget on reasoning alone and return
      // empty content, or even cut the reasoning trace itself off mid-
      // thought before ever reaching an answer.
      ...(disableReasoning ? { reasoning: { enabled: false } } : {}),
      ...(tools && tools.length > 0 ? { tools } : {}),
    });

  let response = await fetch(`${fastify.config.OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: openRouterHeaders(fastify),
    body: bodyFor(true),
  });

  // Reasoning policy is provider-specific, not something this backend
  // controls — live testing found at least one model/provider combination
  // that REJECTS a request to disable reasoning outright ("Reasoning is
  // mandatory for this endpoint and cannot be disabled", 400). Retry once
  // without the field, keyed specifically to that error rather than a
  // general retry-on-any-failure (which would mask real errors instead of
  // this one known, identifiable API-contract mismatch).
  if (!response.ok && response.status === 400) {
    const text = await response.text().catch(() => "");
    if (/reasoning/i.test(text) && /mandatory|cannot be disabled/i.test(text)) {
      response = await fetch(`${fastify.config.OPENROUTER_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: openRouterHeaders(fastify),
        body: bodyFor(false),
      });
    } else {
      throw new Error(`OpenRouter classifier request failed (${response.status}): ${text.slice(0, 500)}`);
    }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenRouter classifier request failed (${response.status}): ${text.slice(0, 500)}`);
  }

  const json = (await response.json()) as {
    id?: string;
    choices?: Array<{
      message?: { content?: string; reasoning?: string; annotations?: Array<{ type?: string; url_citation?: UrlCitation }> };
    }>;
    usage?: OpenRouterUsage;
  };

  const message = json.choices?.[0]?.message;
  const annotations = message?.annotations ?? [];
  const citations = annotations
    .filter((a): a is { type: string; url_citation: UrlCitation } => a.type === "url_citation" && !!a.url_citation)
    .map((a) => a.url_citation);

  // Reasoning-capable models put their internal reasoning trace in a
  // SEPARATE `message.reasoning` field, distinct from `message.content` —
  // and reasoning policy is provider-specific, not something this backend
  // controls: live testing found one model that requires it enabled
  // (rejects a request to disable it) and another that, left to its own
  // defaults on a long/hard prompt, spent its entire max_tokens budget on
  // reasoning and returned a genuinely empty `content` while still being
  // billed for a real completion. Falling back to `reasoning` when
  // `content` is empty handles both cases correctly without needing to
  // know in advance which policy a given model/provider combination uses.
  const rawContent = message?.content ?? "";
  const content = rawContent.trim().length > 0 ? rawContent : (message?.reasoning ?? "");

  return {
    content,
    usage: json.usage ?? null,
    generationId: json.id ?? null,
    citations,
  };
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

// Binary media endpoints (currently /audio/speech) return raw bytes with no
// inline usage/cost field — OpenRouter's documented pattern for those is to
// read the X-Generation-Id response header and resolve real cost afterward
// via this endpoint. Best-effort: a failure here must never fail the
// generation that already succeeded, so callers get 0 (falls back to the
// existing "floor of 1 credit" behavior in mediaCost.ts) rather than a thrown error.
export async function fetchGenerationCost(fastify: FastifyInstance, generationId: string): Promise<number> {
  try {
    const response = await fetch(`${fastify.config.OPENROUTER_BASE_URL}/generation?id=${encodeURIComponent(generationId)}`, {
      headers: { Authorization: `Bearer ${fastify.config.OPENROUTER_API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return 0;
    const json = (await response.json()) as { data?: { total_cost?: number }; total_cost?: number };
    return json.data?.total_cost ?? json.total_cost ?? 0;
  } catch (err) {
    fastify.log.warn({ err, generationId }, "fetchGenerationCost failed, defaulting to 0");
    return 0;
  }
}
