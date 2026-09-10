import type { FastifyPluginAsync } from "fastify";
import { getProStatus, handleCreateProWorkflow } from "../handlers/pro.js";
import { RATE_LIMITS } from "../handlers/rateLimits.js";
import { sendResult } from "./sendResult.js";

// HTTP adapter only. Behaviour lives in handlers/pro.ts, shared verbatim
// with the Worker entry point (worker/routes/pro.ts) — same split as
// every other route in this codebase (see routes/sendResult.ts).
const proRoutes: FastifyPluginAsync = async (fastify) => {
  // Unauthenticated by design — see handlers/pro.ts's own doc comment for
  // why this specific route is the one safe thing to expose while Pro is
  // otherwise fully gated.
  fastify.get("/pro/status", async (_request, reply) => sendResult(reply, getProStatus(fastify)));

  fastify.post(
    "/pro/workflows",
    {
      preHandler: [
        fastify.authenticate,
        fastify.rateLimitByUser("pro_create_workflow", RATE_LIMITS.pro_create_workflow.max, RATE_LIMITS.pro_create_workflow.windowMs),
      ],
    },
    async (request, reply) => sendResult(reply, await handleCreateProWorkflow(fastify, request.user, request.body as Record<string, unknown>)),
  );
};

export default proRoutes;
