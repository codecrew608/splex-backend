import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getOwnedGeneratedMedia, updateGeneratedMediaStatus } from "../credits/mediaQuota.js";
import { computeMediaCreditsCharged } from "../credits/mediaCost.js";
import { consumeCredits } from "../credits/consumeCredits.js";
import { updateMessageResult } from "../persistence/messages.js";
import { pollVideoJob, downloadAndStoreVideo } from "../video/generate.js";

const paramsSchema = z.object({ mediaId: z.string().uuid() });

// Client-safe status payload only — never provider_job_id, prompt (may
// contain content the user wouldn't expect echoed back through a generic
// status poll), or any internal error detail beyond a friendly message.
interface MediaStatusResponse {
  status: "queued" | "processing" | "completed" | "failed";
  url?: string;
  errorMessage?: string;
}

const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 365;

// The frontend polls this every 6s (useChatStream.ts's MEDIA_POLL_INTERVAL_MS)
// while a video job is in flight — ~10 requests/minute for the one job
// concurrency allows. 30/min gives legitimate polling generous headroom
// while still capping a scripted caller from turning this into a way to
// force repeated real OpenRouter poll calls (every non-terminal status
// check here calls out to OpenRouter, unlike a purely local read).
const MEDIA_STATUS_RATE_LIMIT = { max: 30, windowMs: 60_000 };

const mediaRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /media/:mediaId/status — polled by the frontend while an async
  // media job (currently: video) is still in flight. "Check on read"
  // rather than a background worker: no queue/cron infra exists in this
  // codebase today (see DEPLOYMENT.md — the backend is a single long-lived
  // Fastify process, nothing else), and video's volume (Pro-only, 2/day,
  // 1 concurrent) doesn't remotely justify standing one up for v1. Once a
  // row is terminal, this never calls out to OpenRouter again — it just
  // reads the row and (for 'completed') mints a fresh signed URL from the
  // already-stored file.
  fastify.get(
    "/media/:mediaId/status",
    {
      preHandler: [
        fastify.authenticate,
        fastify.rateLimitByUser("media_status", MEDIA_STATUS_RATE_LIMIT.max, MEDIA_STATUS_RATE_LIMIT.windowMs),
      ],
    },
    async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ message: "Invalid request." });
    }

    const media = await getOwnedGeneratedMedia(fastify, request.user.id, params.data.mediaId);
    if (!media) {
      return reply.code(404).send({ message: "Not found." });
    }

    if (media.status === "completed") {
      if (!media.storage_path) {
        // Shouldn't happen (storage_path is set in the same update that
        // sets status='completed' below) — fail safe rather than 500.
        return reply.send({ status: "failed", errorMessage: "Video generation failed. Please try again." } satisfies MediaStatusResponse);
      }
      const { data: signed, error: signError } = await fastify.supabaseAdmin.storage
        .from("uploads")
        .createSignedUrl(media.storage_path, SIGNED_URL_TTL_SECONDS);
      if (signError || !signed) {
        fastify.log.error({ signError, mediaId: media.id }, "failed to re-sign completed video URL");
        return reply.code(500).send({ message: "Something went wrong. Please try again." });
      }
      return reply.send({ status: "completed", url: signed.signedUrl } satisfies MediaStatusResponse);
    }

    if (media.status === "failed" || media.status === "cancelled") {
      return reply.send({ status: "failed", errorMessage: "Video generation failed. Please try again." } satisfies MediaStatusResponse);
    }

    // Still queued/processing — actually check with OpenRouter. provider_job_id
    // holds the polling_url returned at submission time (see video/generate.ts).
    if (!media.provider_job_id) {
      return reply.send({ status: "processing" } satisfies MediaStatusResponse);
    }

    let poll: Awaited<ReturnType<typeof pollVideoJob>>;
    try {
      poll = await pollVideoJob(fastify, media.provider_job_id);
    } catch (err) {
      // Transport/HTTP failure talking to OpenRouter — not the job itself
      // failing. Report "still processing" so the frontend just tries
      // again on its next poll rather than surfacing a false failure.
      fastify.log.warn({ err, mediaId: media.id }, "video poll failed, will retry on next client poll");
      return reply.send({ status: media.status === "queued" ? "queued" : "processing" } satisfies MediaStatusResponse);
    }

    if (poll.status === "pending") {
      if (media.status === "queued") {
        await updateGeneratedMediaStatus(fastify, media.id, { status: "processing" });
      }
      return reply.send({ status: "processing" } satisfies MediaStatusResponse);
    }

    if (poll.status !== "completed") {
      // failed | cancelled | expired — all collapse to SPLEX's 'failed' so
      // they're excluded from the daily quota count (checkMediaQuota
      // excludes status='failed'), matching "never charge/count a failure."
      await updateGeneratedMediaStatus(fastify, media.id, {
        status: "failed",
        errorMessage: poll.errorMessage ?? poll.status,
      });
      if (media.message_id) {
        await updateMessageResult(fastify, media.message_id, { content: "Video generation failed. Please try again." });
      }
      return reply.send({ status: "failed", errorMessage: "Video generation failed. Please try again." } satisfies MediaStatusResponse);
    }

    if (!poll.contentUrl) {
      fastify.log.error({ mediaId: media.id }, "video job completed but contentUrl missing");
      await updateGeneratedMediaStatus(fastify, media.id, { status: "failed", errorMessage: "missing content url" });
      return reply.send({ status: "failed", errorMessage: "Video generation failed. Please try again." } satisfies MediaStatusResponse);
    }

    try {
      const stored = await downloadAndStoreVideo(fastify, request.user.id, poll.contentUrl);
      const creditsCharged = computeMediaCreditsCharged(fastify, poll.costUsd ?? 0);
      // Set at job submission (routes/chat.ts) and persisted specifically so
      // it's available here, in a separate later request — see migration
      // 0013's comment on this column for why that's necessary.
      const modelId = media.openrouter_model_id ?? "unknown";

      await updateGeneratedMediaStatus(fastify, media.id, {
        status: "completed",
        storagePath: stored.storagePath,
        costUsd: poll.costUsd ?? 0,
        creditsCharged,
      });

      if (media.message_id) {
        await updateMessageResult(fastify, media.message_id, { content: `[Generated video](${stored.url})`, creditsCharged, routedModel: modelId });
      }

      await consumeCredits(fastify, {
        userId: request.user.id,
        creditCost: creditsCharged,
        intent: "video_generation",
        complexity: "medium",
        openrouterModelId: modelId,
        realCostEstimate: poll.costUsd ?? 0,
      });

      return reply.send({ status: "completed", url: stored.url } satisfies MediaStatusResponse);
    } catch (err) {
      fastify.log.error({ err, mediaId: media.id }, "failed to download/store completed video");
      await updateGeneratedMediaStatus(fastify, media.id, { status: "failed", errorMessage: "download/store failed" });
      if (media.message_id) {
        await updateMessageResult(fastify, media.message_id, { content: "Video generation failed. Please try again." });
      }
      return reply.send({ status: "failed", errorMessage: "Video generation failed. Please try again." } satisfies MediaStatusResponse);
    }
  });
};

export default mediaRoutes;
