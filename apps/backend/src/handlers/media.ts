import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getOwnedGeneratedMedia, updateGeneratedMediaStatus } from "../credits/mediaQuota.js";
import { computeMediaCreditsCharged } from "../credits/mediaCost.js";
import { consumeCredits } from "../credits/consumeCredits.js";
import { settleMediaReservation } from "../credits/checkCredits.js";
import { updateMessageResult } from "../persistence/messages.js";
import { pollVideoJob, downloadAndStoreVideo } from "../video/generate.js";
import { type HandlerResult, ok, fail } from "./result.js";

const mediaIdSchema = z.string().uuid();

// Client-safe status payload only — never provider_job_id, prompt (may
// contain content the user wouldn't expect echoed back through a generic
// status poll), or any internal error detail beyond a friendly message.
export interface MediaStatusResponse {
  status: "queued" | "processing" | "completed" | "failed";
  url?: string;
  errorMessage?: string;
}

// 7 days, not a year.
//
// A signed URL is a bearer capability: anyone holding it can fetch the
// object, with no auth and no revocation. A 365-day lifetime meant one
// leaked link (browser history, a shared screenshot, a proxy log) exposed
// that video for a year.
//
// 7 days is safe because the URL is NOT the durable reference — the client
// re-polls /media/:id/status, which mints a fresh URL from the stored path
// on every call, and the chat message stores the storage path rather than
// the signed link. So expiry costs a re-poll, not access.
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7;
const FAILED_MESSAGE = "Video generation failed. Please try again.";

// GET /media/:mediaId/status — polled by the frontend while an async media
// job (currently: video) is still in flight. "Check on read" rather than a
// background worker: no queue/cron infra exists in this codebase, and
// video's volume (Pro-only, 2/day, 1 concurrent) doesn't justify standing
// one up. Once a row is terminal this never calls OpenRouter again — it
// just reads the row and (for 'completed') mints a fresh signed URL from
// the already-stored file.
//
// Previously duplicated in full between routes/media.ts and
// worker/routes/media.ts, including the credit-charging path — meaning a
// billing bug fixed in one would silently persist in the other.
export async function getMediaStatus(
  fastify: FastifyInstance,
  userId: string,
  rawMediaId: string,
): Promise<HandlerResult<MediaStatusResponse>> {
  const parsed = mediaIdSchema.safeParse(rawMediaId);
  if (!parsed.success) return fail("Invalid request.", 400);

  const media = await getOwnedGeneratedMedia(fastify, userId, parsed.data);
  if (!media) return fail("Not found.", 404);

  if (media.status === "completed") {
    if (!media.storage_path) {
      // Shouldn't happen (storage_path is set in the same update that sets
      // status='completed' below) — fail safe rather than 500.
      return ok<MediaStatusResponse>({ status: "failed", errorMessage: FAILED_MESSAGE });
    }
    const { data: signed, error: signError } = await fastify.supabaseAdmin.storage
      .from("uploads")
      .createSignedUrl(media.storage_path, SIGNED_URL_TTL_SECONDS);
    if (signError || !signed) {
      fastify.log.error({ signError, mediaId: media.id }, "failed to re-sign completed video URL");
      return fail("Something went wrong. Please try again.", 500);
    }
    return ok<MediaStatusResponse>({ status: "completed", url: signed.signedUrl });
  }

  if (media.status === "failed" || media.status === "cancelled") {
    // Idempotent: a no-op once already settled, which matters because the
    // client polls this endpoint repeatedly.
    await settleMediaReservation(fastify, media.id, 0);
    return ok<MediaStatusResponse>({ status: "failed", errorMessage: FAILED_MESSAGE });
  }

  // Still queued/processing — actually check with OpenRouter. provider_job_id
  // holds the polling_url returned at submission time (see video/generate.ts).
  if (!media.provider_job_id) {
    return ok<MediaStatusResponse>({ status: "processing" });
  }

  let poll: Awaited<ReturnType<typeof pollVideoJob>>;
  try {
    poll = await pollVideoJob(fastify, media.provider_job_id);
  } catch (err) {
    // Transport/HTTP failure talking to OpenRouter — not the job itself
    // failing. Report "still processing" so the frontend just tries again
    // on its next poll rather than surfacing a false failure.
    fastify.log.warn({ err, mediaId: media.id }, "video poll failed, will retry on next client poll");
    return ok<MediaStatusResponse>({ status: media.status === "queued" ? "queued" : "processing" });
  }

  if (poll.status === "pending") {
    if (media.status === "queued") {
      await updateGeneratedMediaStatus(fastify, media.id, { status: "processing" });
    }
    return ok<MediaStatusResponse>({ status: "processing" });
  }

  if (poll.status !== "completed") {
    // failed | cancelled | expired — all collapse to SPLEX's 'failed' so
    // they're excluded from the daily quota count (checkMediaQuota excludes
    // status='failed'), matching "never charge/count a failure."
    await updateGeneratedMediaStatus(fastify, media.id, {
      status: "failed",
      errorMessage: poll.errorMessage ?? poll.status,
    });
    if (media.message_id) {
      await updateMessageResult(fastify, media.message_id, { content: FAILED_MESSAGE, status: "failed" });
    }
    await settleMediaReservation(fastify, media.id, 0);
    return ok<MediaStatusResponse>({ status: "failed", errorMessage: FAILED_MESSAGE });
  }

  if (!poll.contentUrl) {
    fastify.log.error({ mediaId: media.id }, "video job completed but contentUrl missing");
    await updateGeneratedMediaStatus(fastify, media.id, { status: "failed", errorMessage: "missing content url" });
    await settleMediaReservation(fastify, media.id, 0);
    return ok<MediaStatusResponse>({ status: "failed", errorMessage: FAILED_MESSAGE });
  }

  try {
    const stored = await downloadAndStoreVideo(fastify, userId, poll.contentUrl);
    const creditsCharged = computeMediaCreditsCharged(fastify, poll.costUsd ?? 0);
    // Set at job submission and persisted specifically so it's available
    // here, in a separate later request — see migration 0013's comment on
    // this column for why that's necessary.
    const modelId = media.openrouter_model_id ?? "unknown";

    await updateGeneratedMediaStatus(fastify, media.id, {
      status: "completed",
      storagePath: stored.storagePath,
      costUsd: poll.costUsd ?? 0,
      creditsCharged,
    });

    if (media.message_id) {
      await updateMessageResult(fastify, media.message_id, {
        content: `[Generated video](${stored.url})`,
        creditsCharged,
        routedModel: modelId,
        status: "complete",
      });
    }

    // Trues the DAILY reservation up/down from the submit-time estimate to
    // the real charge. consumeCredits below still handles the monthly pool
    // and the ledger row, exactly as before — settling only touches the
    // daily counter the reservation was taken from, against the period it
    // was taken in (a job spanning midnight IST settles the correct day).
    await settleMediaReservation(fastify, media.id, creditsCharged);

    await consumeCredits(fastify, {
      userId,
      creditCost: creditsCharged,
      intent: "video_generation",
      complexity: "medium",
      openrouterModelId: modelId,
      realCostEstimate: poll.costUsd ?? 0,
      // The daily side is already settled above; charging it again here
      // would double-count this generation against the daily cap.
      skipDaily: true,
    });

    return ok<MediaStatusResponse>({ status: "completed", url: stored.url });
  } catch (err) {
    fastify.log.error({ err, mediaId: media.id }, "failed to download/store completed video");
    await updateGeneratedMediaStatus(fastify, media.id, { status: "failed", errorMessage: "download/store failed" });
    await settleMediaReservation(fastify, media.id, 0);
    if (media.message_id) {
      await updateMessageResult(fastify, media.message_id, { content: FAILED_MESSAGE, status: "failed" });
    }
    return ok<MediaStatusResponse>({ status: "failed", errorMessage: FAILED_MESSAGE });
  }
}
