import type { FastifyPluginAsync } from "fastify";
import { getMediaStatus } from "../handlers/media.js";
import { RATE_LIMITS } from "../handlers/rateLimits.js";
import { sendResult } from "./sendResult.js";

// HTTP adapter only. Behaviour lives in handlers/media.ts, shared verbatim
// with the Worker entry point (worker/routes/media.ts).
//
// The frontend polls this every 6s (useChatStream.ts's MEDIA_POLL_INTERVAL_MS)
// while a video job is in flight — ~10 requests/minute for the one job
// concurrency allows. 30/min gives legitimate polling generous headroom while
// still capping a scripted caller from forcing repeated real OpenRouter poll
// calls (every non-terminal status check calls out to OpenRouter, unlike a
// purely local read).
const mediaRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/media/:mediaId/status",
    {
      preHandler: [
        fastify.authenticate,
        fastify.rateLimitByUser("media_status", RATE_LIMITS.media_status.max, RATE_LIMITS.media_status.windowMs),
      ],
    },
    async (request, reply) => {
      const { mediaId } = request.params as { mediaId: string };
      return sendResult(reply, await getMediaStatus(fastify, request.user.id, mediaId));
    },
  );
};

export default mediaRoutes;
