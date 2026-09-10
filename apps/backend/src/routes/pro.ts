import type { FastifyPluginAsync } from "fastify";
import { getProStatus, handleCreateProWorkflow, handleStepProWorkflow, handleClarifyProWorkflow, handleGetProWorkflow, handleCancelProWorkflow } from "../handlers/pro.js";
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

  fastify.post(
    "/pro/workflows/:id/step",
    {
      preHandler: [
        fastify.authenticate,
        fastify.rateLimitByUser("pro_step_workflow", RATE_LIMITS.pro_step_workflow.max, RATE_LIMITS.pro_step_workflow.windowMs),
      ],
    },
    async (request, reply) => sendResult(reply, await handleStepProWorkflow(fastify, request.user, (request.params as { id: string }).id)),
  );

  fastify.post(
    "/pro/workflows/:id/clarify",
    {
      preHandler: [
        fastify.authenticate,
        fastify.rateLimitByUser("pro_clarify_workflow", RATE_LIMITS.pro_clarify_workflow.max, RATE_LIMITS.pro_clarify_workflow.windowMs),
      ],
    },
    async (request, reply) =>
      sendResult(reply, await handleClarifyProWorkflow(fastify, request.user, (request.params as { id: string }).id, request.body as Record<string, unknown>)),
  );

  fastify.post(
    "/pro/workflows/:id/cancel",
    {
      preHandler: [
        fastify.authenticate,
        fastify.rateLimitByUser("pro_cancel_workflow", RATE_LIMITS.pro_cancel_workflow.max, RATE_LIMITS.pro_cancel_workflow.windowMs),
      ],
    },
    async (request, reply) => sendResult(reply, await handleCancelProWorkflow(fastify, request.user, (request.params as { id: string }).id)),
  );

  fastify.get(
    "/pro/workflows/:id",
    {
      preHandler: [
        fastify.authenticate,
        fastify.rateLimitByUser("pro_get_workflow", RATE_LIMITS.pro_get_workflow.max, RATE_LIMITS.pro_get_workflow.windowMs),
      ],
    },
    async (request, reply) => sendResult(reply, await handleGetProWorkflow(fastify, request.user, (request.params as { id: string }).id)),
  );
};

export default proRoutes;
