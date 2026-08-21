import type { FastifyInstance } from "fastify";
import { openRouterHeaders } from "../openrouter/client.js";
import { storeGeneratedMedia, type StoredMedia } from "../media/storage.js";

// SPLEX-side policy cap (spec: "Maximum duration: 10 seconds initially").
// The registered model (google/veo-3.1-lite, see migration 0013) natively
// supports 4-8s clips, so 8 is both the model's real ceiling and
// comfortably under the policy cap — there's no case where these two
// numbers need to be reconciled at request time.
const VIDEO_DURATION_SECONDS = 8;

export interface VideoJob {
  jobId: string;
  pollingUrl: string;
}

// OpenRouter's status vocabulary (verified against their video-generation
// API contract): pending -> completed | failed | cancelled | expired.
// There is no distinct provider-reported "processing" state — SPLEX's own
// 'processing' status (see mediaQuota.ts's MediaStatus) is a purely local
// UX distinction (see routes/media.ts: set once we've actually polled and
// it's still pending), not something OpenRouter tells us directly.
export type OpenRouterVideoStatus = "pending" | "completed" | "failed" | "cancelled" | "expired";

export interface VideoPollResult {
  status: OpenRouterVideoStatus;
  contentUrl?: string; // unsigned_urls[0] — still requires our own Authorization header to fetch
  costUsd?: number;
  errorMessage?: string;
}

// Submits an async video generation job (POST /videos — NOT /chat/completions
// or /images; video has its own job-based API, see
// https://openrouter.ai/docs/guides/overview/multimodal/video-generation).
// Returns immediately with a job id + polling URL — the actual generation
// can take well over a minute, which is exactly why this is fire-and-poll
// rather than a single blocking call like image/audio.
export async function submitVideoJob(fastify: FastifyInstance, model: string, prompt: string): Promise<VideoJob> {
  const response = await fetch(`${fastify.config.OPENROUTER_BASE_URL}/videos`, {
    method: "POST",
    headers: openRouterHeaders(fastify),
    body: JSON.stringify({ model, prompt, duration: VIDEO_DURATION_SECONDS, aspect_ratio: "16:9" }),
    signal: AbortSignal.timeout(30_000), // submission only — not the generation itself
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenRouter video submit failed (${response.status}): ${text.slice(0, 500)}`);
  }

  const json = (await response.json()) as { id?: string; polling_url?: string; status?: string };
  if (!json.id || !json.polling_url) {
    throw new Error("OpenRouter video submit response missing id/polling_url");
  }

  return { jobId: json.id, pollingUrl: json.polling_url };
}

// Checks current status of an in-flight job. Never throws on a normal
// terminal/non-terminal status — only on a genuine transport/HTTP failure,
// which the caller (routes/media.ts) treats as "try again on the next
// poll," not as the job itself having failed.
export async function pollVideoJob(fastify: FastifyInstance, pollingUrl: string): Promise<VideoPollResult> {
  const response = await fetch(pollingUrl, {
    headers: { Authorization: `Bearer ${fastify.config.OPENROUTER_API_KEY}` },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenRouter video poll failed (${response.status}): ${text.slice(0, 500)}`);
  }

  const json = (await response.json()) as {
    status?: OpenRouterVideoStatus;
    unsigned_urls?: string[];
    error?: string;
    usage?: { cost?: number };
  };

  const status = json.status ?? "pending";
  return {
    status,
    contentUrl: json.unsigned_urls?.[0],
    costUsd: json.usage?.cost,
    errorMessage: json.error,
  };
}

// Downloads the finished video's bytes (the unsigned_urls entry still
// requires our API key — "unsigned" here means "not yet a signed URL of
// ours", not "publicly fetchable") and re-stores it the same way every
// other generated-media kind does, so delivery to the client is uniform
// regardless of kind.
export async function downloadAndStoreVideo(fastify: FastifyInstance, userId: string, contentUrl: string): Promise<StoredMedia> {
  const response = await fetch(contentUrl, {
    headers: { Authorization: `Bearer ${fastify.config.OPENROUTER_API_KEY}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`Failed to download generated video (${response.status})`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error("Downloaded video content was empty");
  }

  return storeGeneratedMedia(fastify, userId, bytes, "video/mp4", "mp4");
}
