import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

export interface StoredMedia {
  storagePath: string;
  url: string;
}

// Signed URL lifetime for generated media embedded in chat history.
// Long-lived rather than permanent (Storage stays private, so there's no
// public URL to hand out instead) — a year comfortably outlives any
// realistic "still viewing this old conversation" case for a v1 feature.
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 365;

// Shared by every generated-media kind (image, audio, and video/PPT once
// built) — uploads bytes into the same private "uploads" Storage bucket
// files already use, under a distinct generated/ prefix so this never
// collides with, or counts against, a user's file-upload rows/quota, then
// returns a signed URL the caller can embed directly in message content.
export async function storeGeneratedMedia(
  fastify: FastifyInstance,
  userId: string,
  bytes: Buffer,
  mime: string,
  ext: string,
): Promise<StoredMedia> {
  const storagePath = `generated/${userId}/${randomUUID()}.${ext}`;

  const { error: uploadError } = await fastify.supabaseAdmin.storage
    .from("uploads")
    .upload(storagePath, bytes, { contentType: mime });
  if (uploadError) {
    throw new Error(`Failed to store generated media: ${uploadError.message}`);
  }

  const { data: signed, error: signError } = await fastify.supabaseAdmin.storage
    .from("uploads")
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
  if (signError || !signed) {
    throw new Error(`Failed to sign generated media URL: ${signError?.message ?? "unknown error"}`);
  }

  return { storagePath, url: signed.signedUrl };
}
