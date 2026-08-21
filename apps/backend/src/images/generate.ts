import type { FastifyInstance } from "fastify";
import { openRouterHeaders } from "../openrouter/client.js";
import { storeGeneratedMedia } from "../media/storage.js";

export interface GenerateImageResult {
  url: string;
  storagePath: string;
  costUsd: number;
}

interface OpenRouterImageResponse {
  data?: Array<{ b64_json?: string; media_type?: string }>;
  usage?: { cost?: number };
}

// Calls OpenRouter's dedicated Image API (POST /images — NOT /chat/completions;
// image generation is a separate endpoint with its own request/response shape,
// see https://openrouter.ai/docs/guides/overview/multimodal/image-generation).
export async function generateImage(
  fastify: FastifyInstance,
  userId: string,
  model: string,
  prompt: string,
): Promise<GenerateImageResult> {
  const response = await fetch(`${fastify.config.OPENROUTER_BASE_URL}/images`, {
    method: "POST",
    headers: openRouterHeaders(fastify),
    body: JSON.stringify({ model, prompt }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenRouter image request failed (${response.status}): ${text.slice(0, 500)}`);
  }

  const json = (await response.json()) as OpenRouterImageResponse;
  const image = json.data?.[0];
  if (!image?.b64_json) {
    throw new Error("OpenRouter image response contained no image data");
  }

  const bytes = Buffer.from(image.b64_json, "base64");
  const mime = image.media_type ?? "image/png";
  const ext = mime.split("/")[1]?.split("+")[0] ?? "png";

  const stored = await storeGeneratedMedia(fastify, userId, bytes, mime, ext);
  return { ...stored, costUsd: json.usage?.cost ?? 0 };
}
