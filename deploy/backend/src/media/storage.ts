import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

export interface StoredMedia {
  storagePath: string;
  url: string;
}

// Signed URL lifetime for generated media embedded in chat history.
//
// A year, DELIBERATELY — unlike the 7 days used for video in
// handlers/media.ts. The difference is whether the URL can be re-minted:
//
//   - Video's URL is NOT the durable reference. The client re-polls
//     GET /media/:id/status, which re-signs from the stored path on every
//     call (owner-checked via getOwnedGeneratedMedia), so a short TTL
//     costs a re-poll, not access.
//   - Image/audio/PPT URLs ARE the durable reference: they're written
//     straight into the assistant message's markdown
//     (`![prompt](url)` / `[Generated audio](url)`) and persisted there.
//     Nothing re-signs them, so the TTL is simply how long that image
//     keeps rendering in the user's own history.
//
// A shorter TTL here would silently break images in older conversations
// rather than improving anything — the object stays private either way,
// and expiry is not a revocation mechanism.
//
// Why not just re-sign on read, like video? Because the browser fetches
// these via a plain `<img src>` / anchor href, which cannot carry an
// Authorization header. A self-authenticating URL is what makes that work
// at all; that's precisely what Supabase signed URLs are for.
//
// Blast radius is bounded by construction, and asserted in
// test/media-security.test.ts:
//   - the path is `generated/<userId>/<uuidv4>` — per-user, and the uuid
//     is unguessable, so one user's URL reveals nothing about another's;
//   - the signature is scoped to that single object, not the bucket or
//     prefix, so it can never be widened into a directory listing;
//   - only the service-role client can mint one; the anon/authenticated
//     roles have no read grant on this bucket at all.
//
// The proper fix, if this ever needs to become short-lived: stop
// embedding the URL, store a `splex-media:<id>` reference in the message
// instead, and have the frontend markdown renderer resolve it through an
// authenticated endpoint that re-signs per view. That is a frontend
// renderer change, not a change here.
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
