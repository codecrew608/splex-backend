import type { FastifyPluginAsync } from "fastify";
import { createProject } from "../handlers/projects.js";
import { RATE_LIMITS } from "../handlers/rateLimits.js";
import { sendResult } from "./sendResult.js";

// HTTP adapter only. Behaviour lives in handlers/projects.ts, shared verbatim
// with the Worker entry point (worker/routes/projects.ts).
const projectsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    "/projects",
    {
      preHandler: [
        fastify.authenticate,
        fastify.rateLimitByUser("projects_create", RATE_LIMITS.projects_create.max, RATE_LIMITS.projects_create.windowMs),
      ],
    },
    async (request, reply) =>
      sendResult(reply, await createProject(fastify, request.user.id, request.user.planTier, request.body, request.user.timezone)),
  );
};

export default projectsRoutes;
