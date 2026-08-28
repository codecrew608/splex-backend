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
  // Required, not optional — omitting this is exactly what caused the
  // OpenRouter 402 bug (see cortex/tokenBudget.ts): with no max_tokens at
  // all, OpenRouter falls back to the served model's own maximum (65536
  // for some models), and its pre-flight affordability check rejects that
  // ceiling even when real usage would be a few hundred tokens. Every
  // caller must resolve one via resolveMaxTokens() first.
  maxTokens: number;
}

export interface StreamCompletionResult {
  fullText: string;
  usage: OpenRouterUsage | null;
  aborted: boolean;
}

// A provider failure that carries WHY, in enumerable fields.
//
// Production logs showed "err: {}" for every model failure, because an
// Error's name/message/stack are non-enumerable own properties: any plain
// JSON serializer (Cloudflare's console capture, pino's default object
// serializer) sees an empty object. Every repeated model failure in
// production was therefore undiagnosable — the exact situation this class
// exists to end.
//
// status/body/model are plain own properties, so they survive
// JSON.stringify and reach `wrangler tail` intact.
//
// The body is truncated and carries only what OpenRouter returned about
// the REQUEST's failure — never the Authorization header, never the
// prompt, never user content.
export class OpenRouterError extends Error {
  readonly status: number;
  readonly body: string;
  readonly model: string | null;
  readonly kind: "stream" | "classifier";

  constructor(kind: "stream" | "classifier", status: number, body: string, model: string | null) {
    // Message shape preserved EXACTLY — isRetryableOpenRouterError,
    // isBalanceExceededError and isModelUnavailableError all regex this
    // string, and existing tests assert on it.
    super(`OpenRouter ${kind === "classifier" ? "classifier request" : "request"} failed (${status}): ${body.slice(0, 500)}`);
    this.name = "OpenRouterError";
    this.status = status;
    this.body = body.slice(0, 500);
    this.model = model;
    this.kind = kind;
  }
}

// Turns any thrown value into plain, enumerable fields a JSON serializer
// can actually render. Use this at EVERY log site that reports a caught
// error, or the log says "{}" and tells you nothing.
export function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof OpenRouterError) {
    return {
      errorName: err.name,
      errorMessage: err.message,
      status: err.status,
      // Provider's own explanation — the single most useful field, and the
      // one that was missing during the outage.
      providerBody: err.body,
      model: err.model,
      retryable: isRetryableOpenRouterError(err),
      modelUnavailable: isModelUnavailableError(err),
      balanceExceeded: isBalanceExceededError(err),
    };
  }
  if (err instanceof Error) {
    return { errorName: err.name, errorMessage: err.message, errorStack: err.stack?.slice(0, 600) };
  }
  return { errorName: typeof err, errorMessage: String(err) };
}

export function openRouterHeaders(fastify: FastifyInstance): Record<string, string> {
  return {
    Authorization: `Bearer ${fastify.config.OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
    "HTTP-Referer": fastify.config.OPENROUTER_SITE_URL,
    "X-Title": fastify.config.OPENROUTER_APP_NAME,
  };
}

// Upstream call deadlines.
//
// Before this, streamCompletion carried only the CALLER's abort signal
// (client disconnect) and completeOnce carried none at all — so a hung
// OpenRouter connection had no upper bound. That matters most for
// completeOnce, which runs the Cortex classifier on the critical path of
// every message keywords cannot settle: a stalled classifier meant the
// user's chat simply never answered, with nothing to time it out.
//
// Streaming gets the longer budget because a long generation legitimately
// holds the connection open; the non-streaming path is a short structured
// call (classification, memory extraction, a research stage) and should
// never take this long.
const STREAM_TIMEOUT_MS = 180_000;
const COMPLETE_TIMEOUT_MS = 60_000;

// Combines the caller's signal (client went away) with a deadline. Prefers
// AbortSignal.any where available — supported on Workers and Node >=20,
// which is every runtime this ships to — and degrades to the timeout alone
// rather than throwing if some future runtime lacks it.
function withDeadline(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  return typeof anyFn === "function" ? anyFn([signal, timeout]) : timeout;
}

// Streams a completion from OpenRouter, invoking onToken for each delta as
// it arrives. Never streamed directly to the client 1:1 without going
// through the caller's SSE writer — callers own the client-facing framing.
export async function streamCompletion(opts: StreamCompletionOptions): Promise<StreamCompletionResult> {
  const { fastify, model, messages, signal, onToken, maxTokens } = opts;

  const response = await fetch(`${fastify.config.OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: openRouterHeaders(fastify),
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: maxTokens,
    }),
    signal: withDeadline(signal, STREAM_TIMEOUT_MS),
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new OpenRouterError("stream", response.status, text, model);
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
  // Optional caller deadline — e.g. deep research's whole-run budget, so a
  // multi-stage run cannot outlive it one 60s stage at a time.
  signal?: AbortSignal;
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
    // Caller signal (e.g. deep research's whole-run deadline) combined with
    // this call's own ceiling — whichever fires first wins.
    signal: withDeadline(opts.signal, COMPLETE_TIMEOUT_MS),
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
        signal: withDeadline(opts.signal, COMPLETE_TIMEOUT_MS),
      });
    } else {
      throw new OpenRouterError("classifier", response.status, text, model);
    }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new OpenRouterError("classifier", response.status, text, model);
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
  return (
    /OpenRouter (request|classifier request) failed \((429|5\d\d)\)/.test(err.message) ||
    // A model that no longer exists is permanently dead for THAT model but
    // says nothing about the next candidate, so the fallback chain must
    // keep going. Without this a single stale registry row aborted the
    // whole request — see isModelUnavailableError below for the live
    // incident this comes from.
    isModelUnavailableError(err)
  );
}

// "This specific model can't serve the request at all" — as opposed to
// "the upstream is busy" (429/5xx, retryable) or "the account is out of
// money" (402, retryable with nothing). OpenRouter answers 404 with
// "No endpoints found for <model>" when a model id has been withdrawn or
// has no live provider endpoints left.
//
// This existed as an unhandled gap, found in production: the registry
// still listed nvidia/nemotron-nano-9b-v2:free after OpenRouter dropped
// it, every call 404'd, and because 404 matched neither the retryable nor
// the balance branch, the candidate loop rethrew immediately instead of
// trying the next Free model — surfacing as a generic "Something went
// wrong" even while a perfectly good Free candidate sat unused.
//
// Deliberately NOT folded into a plain 4xx match: 400/401/403/422 mean the
// REQUEST is wrong (bad key, malformed body, unsupported parameter), and
// those would fail identically against every other candidate, so burning
// the whole fallback chain on them just multiplies latency for the same
// end result.
export function isModelUnavailableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    /OpenRouter (request|classifier request) failed \(404\)/.test(err.message) ||
    /No endpoints found/i.test(err.message)
  );
}

// 402 specifically means "the account's available balance can't cover
// this request's budget" — not a bug in the request shape, and not
// retryable with a fallback model (every model has the same account
// behind it). Distinguished from other errors so the caller can show a
// clear, honest "temporarily unavailable" message instead of the generic
// "Something went wrong" — never exposes the account/balance detail
// itself to the client, only that this specific class of failure happened.
export function isBalanceExceededError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /OpenRouter (request|classifier request) failed \(402\)/.test(err.message);
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
