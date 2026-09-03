import type { FastifyPluginAsync } from "fastify";
import { submitFeedback, feedbackBodySchema } from "../handlers/feedback.js";
import { RATE_LIMITS } from "../handlers/rateLimits.js";
import { sendResult } from "./sendResult.js";

// HTTP adapter only. Behaviour lives in handlers/feedback.ts, shared with
// the Worker entry point (worker/routes/feedback.ts).
const feedbackRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    "/feedback",
    {
      preHandler: [
        fastify.authenticate,
        fastify.rateLimitByUser("feedback_submit", RATE_LIMITS.feedback_submit.max, RATE_LIMITS.feedback_submit.windowMs),
      ],
    },
    async (request, reply) => {
      const parsed = feedbackBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ message: "Invalid request." });
      }

      // Node keeps the process alive on its own — see handlers/chat.ts's
      // identical pattern (ScheduleBackground's own doc comment) for why
      // the Worker side needs execCtx.waitUntil() instead.
      const result = await submitFeedback(fastify, request.user, parsed.data, (work) => {
        void work.catch((err: unknown) => {
          fastify.log.warn({ err }, "feedback notification email failed (non-fatal)");
        });
      });
      return sendResult(reply, result);
    },
  );
};

export default feedbackRoutes;
