import fp from "fastify-plugin";
import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";

export default fp(async function corsPlugin(fastify: FastifyInstance) {
  // Logged once at boot specifically so a CORS failure in production is
  // diagnosable from the deploy platform's logs alone — "does the
  // configured origin actually match what the browser sent" is the first
  // thing to check, and previously that meant re-deriving it from an env
  // var no one could see at a glance.
  fastify.log.info({ allowedOrigins: fastify.config.FRONTEND_ORIGIN }, "CORS allowed origins");

  await fastify.register(cors, {
    origin: fastify.config.FRONTEND_ORIGIN,
    credentials: true,
    // @fastify/cors defaults to 'GET,HEAD,POST' — silently blocking every
    // DELETE route (message truncate/edit, account deletion) cross-origin.
    // Cover every method actually in use.
    methods: ["GET", "POST", "DELETE"],
  });
});
