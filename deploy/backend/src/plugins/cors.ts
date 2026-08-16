import fp from "fastify-plugin";
import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";

export default fp(async function corsPlugin(fastify: FastifyInstance) {
  await fastify.register(cors, {
    origin: fastify.config.FRONTEND_ORIGIN,
    credentials: true,
    // @fastify/cors defaults to 'GET,HEAD,POST' — silently blocking every
    // DELETE route (message truncate/edit, account deletion) cross-origin.
    // Cover every method actually in use.
    methods: ["GET", "POST", "DELETE"],
  });
});
