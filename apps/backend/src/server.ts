import Fastify, { type FastifyError } from "fastify";
import { FastifySSEPlugin } from "fastify-sse-v2";
import envPlugin from "./plugins/env.js";
import supabaseAdminPlugin from "./plugins/supabaseAdmin.js";
import authPlugin from "./plugins/auth.js";
import corsPlugin from "./plugins/cors.js";
import rateLimitPlugin from "./plugins/rateLimit.js";
import userRateLimitPlugin from "./plugins/userRateLimit.js";
import healthRoutes from "./routes/health.js";
import chatRoutes from "./routes/chat.js";
import filesRoutes from "./routes/files.js";
import projectsRoutes from "./routes/projects.js";
import billingRoutes from "./routes/billing.js";
import accountRoutes from "./routes/account.js";
import mediaRoutes from "./routes/media.js";
import entitlementsRoutes from "./routes/entitlements.js";

async function main() {
  const fastify = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
  });

  await fastify.register(envPlugin);
  await fastify.register(supabaseAdminPlugin);
  await fastify.register(authPlugin);
  await fastify.register(corsPlugin);
  await fastify.register(rateLimitPlugin);
  await fastify.register(userRateLimitPlugin);
  await fastify.register(FastifySSEPlugin);

  // Backstop only — every route in this codebase already catches its own
  // errors and sends a generic client-facing message (see chat.ts,
  // research/handler.ts, etc.). This exists for whatever inevitably isn't
  // covered by that convention yet (a route added later without a
  // try/catch, an exception thrown from a preHandler): without it,
  // Fastify's own default handler echoes a thrown error's raw .message
  // in the response body, which for an unexpected internal exception
  // (a raw Postgres error, a library's internal message, ...) could leak
  // details the client should never see. 4xx errors are left untouched —
  // those already carry deliberately-authored, safe messages (Zod
  // validation, the rate-limit plugins' own errors, fastify.authenticate's
  // 401) that are fine to pass straight through.
  fastify.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      fastify.log.error({ err: error, reqId: request.id, url: request.url }, "unhandled error reached global error handler");
      reply.code(statusCode).send({ message: "Something went wrong. Please try again." });
      return;
    }
    reply.code(statusCode).send({ message: error.message });
  });

  await fastify.register(healthRoutes);
  await fastify.register(chatRoutes);
  await fastify.register(filesRoutes);
  await fastify.register(projectsRoutes);
  await fastify.register(billingRoutes);
  await fastify.register(accountRoutes);
  await fastify.register(mediaRoutes);
  await fastify.register(entitlementsRoutes);

  await fastify.listen({ port: fastify.config.PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
