import type { FastifyInstance } from "fastify";
import { openRouterHeaders, fetchGenerationCost } from "../openrouter/client.js";
import { storeGeneratedMedia } from "../media/storage.js";

export interface GenerateSpeechResult {
  url: string;
  storagePath: string;
  costUsd: number;
  // Estimated from the returned MP3's byte size (see MP3_BYTES_PER_SECOND
  // below) — OpenRouter's TTS response carries no duration field, only raw
  // audio bytes. Persisted to generated_media.duration_seconds and summed
  // for the audio_minutes quota (migration 0033).
  durationSeconds: number;
}

// Standard speech rate used ONLY as a pre-flight estimate, before any
// bytes exist to measure — caps input length so a request can't ask for
// something the 5-minute-per-request ceiling would reject anyway after
// spending. 150 wpm is a commonly cited average TTS/speech rate; this is
// an estimate, not a measurement — the real, billed duration is the
// byte-size-based one computed after generation, below.
const WORDS_PER_MINUTE_ESTIMATE = 150;
export const MAX_AUDIO_MINUTES_PER_REQUEST = 5;
export const MAX_AUDIO_INPUT_WORDS = WORDS_PER_MINUTE_ESTIMATE * MAX_AUDIO_MINUTES_PER_REQUEST;

export function estimateAudioRequestMinutes(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return words / WORDS_PER_MINUTE_ESTIMATE;
}

// 128kbps mono/stereo MP3 (a common default TTS output bitrate) = 16,000
// bytes/sec. Provider responses don't declare their actual bitrate, so
// this is a reasonable estimate, not an exact reading — documented as such
// wherever it's used (generated_media.duration_seconds, the audio_minutes
// quota). Erring toward slightly overestimating duration is the safer
// direction for a quota meant to bound cost, not the reverse.
const MP3_BYTES_PER_SECOND = 16_000;

// Neutral default voice for the registered TTS model (see migration
// 0018) — OpenRouter requires an explicit voice unless the provider
// documents a default, and voice IDs are PER-MODEL, not a shared
// universal set (confirmed live: "alloy" is OpenAI's own convention and
// returns a 404 on mistralai/voxtral-mini-tts-2603, the model this
// constant must now match — its real supported_voices list is on
// GET /api/v1/models?output_modalities=speech). Not user-selectable in
// v1 (SPLEX picks the model, not the user), kept as one constant so it's
// easy to change — but this constant is coupled to whichever model is
// currently registered for the "audio" category in model_registry, and
// MUST be updated together with it if that model ever changes again.
const DEFAULT_VOICE = "en_paul_neutral";

// Calls OpenRouter's dedicated TTS endpoint (POST /audio/speech —
// OpenAI-Audio-API-compatible, see
// https://openrouter.ai/docs/guides/overview/multimodal/tts). Unlike
// /images, the response is a raw audio byte stream with no inline usage
// field, so real cost is resolved afterward from the X-Generation-Id
// response header via fetchGenerationCost — a best-effort lookup that
// never fails the generation itself (see its doc comment).
export async function generateSpeech(
  fastify: FastifyInstance,
  userId: string,
  model: string,
  text: string,
): Promise<GenerateSpeechResult> {
  const response = await fetch(`${fastify.config.OPENROUTER_BASE_URL}/audio/speech`, {
    method: "POST",
    headers: openRouterHeaders(fastify),
    body: JSON.stringify({ model, input: text, voice: DEFAULT_VOICE, response_format: "mp3" }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`OpenRouter audio request failed (${response.status}): ${errText.slice(0, 500)}`);
  }

  const generationId = response.headers.get("x-generation-id");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error("OpenRouter audio response contained no audio data");
  }

  const stored = await storeGeneratedMedia(fastify, userId, bytes, "audio/mpeg", "mp3");
  const costUsd = generationId ? await fetchGenerationCost(fastify, generationId) : 0;
  const durationSeconds = Math.max(1, Math.round(bytes.length / MP3_BYTES_PER_SECOND));

  return { ...stored, costUsd, durationSeconds };
}
