import { z } from "zod";
import { getOwnedGeneratedMedia, updateGeneratedMediaStatus } from "../../credits/mediaQuota.js";
import { computeMediaCreditsCharged } from "../../credits/mediaCost.js";
import { consumeCredits } from "../../credits/consumeCredits.js";
import { updateMessageResult } from "../../persistence/messages.js";
import { pollVideoJob, downloadAndStoreVideo } from "../../video/generate.js";
import type { WorkerCtx } from "../context.js";
import { asFastifyInstance } from "../context.js";
import type { AuthedUser } from "../../types/index.js";
import { jsonResponse, errorResponse } from "../http.js";

const mediaIdSchema = z.string().uuid();
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 365;

interface MediaStatusResponse {
  status: "queued" | "processing" | "completed" | "failed";
  url?: string;
  errorMessage?: string;
}

// Direct port of routes/media.ts's GET /media/:mediaId/status — same
// "check on read" design (no server-side background worker existed
// before this port, and none exists after it either).
export async function handleMediaStatus(mediaIdParam: string, ctx: WorkerCtx, user: AuthedUser): Promise<Response> {
  const parsed = mediaIdSchema.safeParse(mediaIdParam);
  if (!parsed.success) {
    return errorResponse("Invalid request.", 400);
  }
  const fastify = asFastifyInstance(ctx);

  const media = await getOwnedGeneratedMedia(fastify, user.id, parsed.data);
  if (!media) {
    return errorResponse("Not found.", 404);
  }

  if (media.status === "completed") {
    if (!media.storage_path) {
      return jsonResponse({ status: "failed", errorMessage: "Video generation failed. Please try again." } satisfies MediaStatusResponse);
    }
    const { data: signed, error: signError } = await ctx.supabaseAdmin.storage
      .from("uploads")
      .createSignedUrl(media.storage_path, SIGNED_URL_TTL_SECONDS);
    if (signError || !signed) {
      ctx.log.error({ signError, mediaId: media.id }, "failed to re-sign completed video URL");
      return errorResponse("Something went wrong. Please try again.", 500);
    }
    return jsonResponse({ status: "completed", url: signed.signedUrl } satisfies MediaStatusResponse);
  }

  if (media.status === "failed" || media.status === "cancelled") {
    return jsonResponse({ status: "failed", errorMessage: "Video generation failed. Please try again." } satisfies MediaStatusResponse);
  }

  if (!media.provider_job_id) {
    return jsonResponse({ status: "processing" } satisfies MediaStatusResponse);
  }

  let poll: Awaited<ReturnType<typeof pollVideoJob>>;
  try {
    poll = await pollVideoJob(fastify, media.provider_job_id);
  } catch (err) {
    ctx.log.warn({ err, mediaId: media.id }, "video poll failed, will retry on next client poll");
    return jsonResponse({ status: media.status === "queued" ? "queued" : "processing" } satisfies MediaStatusResponse);
  }

  if (poll.status === "pending") {
    if (media.status === "queued") {
      await updateGeneratedMediaStatus(fastify, media.id, { status: "processing" });
    }
    return jsonResponse({ status: "processing" } satisfies MediaStatusResponse);
  }

  if (poll.status !== "completed") {
    await updateGeneratedMediaStatus(fastify, media.id, {
      status: "failed",
      errorMessage: poll.errorMessage ?? poll.status,
    });
    if (media.message_id) {
      await updateMessageResult(fastify, media.message_id, { content: "Video generation failed. Please try again." });
    }
    return jsonResponse({ status: "failed", errorMessage: "Video generation failed. Please try again." } satisfies MediaStatusResponse);
  }

  if (!poll.contentUrl) {
    ctx.log.error({ mediaId: media.id }, "video job completed but contentUrl missing");
    await updateGeneratedMediaStatus(fastify, media.id, { status: "failed", errorMessage: "missing content url" });
    return jsonResponse({ status: "failed", errorMessage: "Video generation failed. Please try again." } satisfies MediaStatusResponse);
  }

  try {
    const stored = await downloadAndStoreVideo(fastify, user.id, poll.contentUrl);
    const creditsCharged = computeMediaCreditsCharged(fastify, poll.costUsd ?? 0);
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
      userId: user.id,
      creditCost: creditsCharged,
      intent: "video_generation",
      complexity: "medium",
      openrouterModelId: modelId,
      realCostEstimate: poll.costUsd ?? 0,
    });

    return jsonResponse({ status: "completed", url: stored.url } satisfies MediaStatusResponse);
  } catch (err) {
    ctx.log.error({ err, mediaId: media.id }, "failed to download/store completed video");
    await updateGeneratedMediaStatus(fastify, media.id, { status: "failed", errorMessage: "download/store failed" });
    if (media.message_id) {
      await updateMessageResult(fastify, media.message_id, { content: "Video generation failed. Please try again." });
    }
    return jsonResponse({ status: "failed", errorMessage: "Video generation failed. Please try again." } satisfies MediaStatusResponse);
  }
}
