import Fastify from "fastify";
import { FastifySSEPlugin } from "fastify-sse-v2";
import envPlugin from "./plugins/env.js";
import supabaseAdminPlugin from "./plugins/supabaseAdmin.js";
import authPlugin from "./plugins/auth.js";
import corsPlugin from "./plugins/cors.js";
import healthRoutes from "./routes/health.js";
import chatRoutes from "./routes/chat.js";
import filesRoutes from "./routes/files.js";
import projectsRoutes from "./routes/projects.js";
import billingRoutes from "./routes/billing.js";
import accountRoutes from "./routes/account.js";

async function main() {
  const fastify = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
  });

  await fastify.register(envPlugin);
  await fastify.register(supabaseAdminPlugin);
  await fastify.register(authPlugin);
  await fastify.register(corsPlugin);
  await fastify.register(FastifySSEPlugin);

  await fastify.register(healthRoutes);
  await fastify.register(chatRoutes);
  await fastify.register(filesRoutes);
  await fastify.register(projectsRoutes);
  await fastify.register(billingRoutes);
  await fastify.register(accountRoutes);

  await fastify.listen({ port: fastify.config.PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
