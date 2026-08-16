import type { FastifyPluginAsync } from "fastify";

// Deleting the auth.users row cascades through users -> projects ->
// conversations -> messages -> cortex_decisions, files -> file_chunks,
// subscriptions, usage_counters, credit_usage_logs, etc. — the ON DELETE
// CASCADE chain already defined in the schema does the actual cleanup, this
// route just triggers it via the admin API (only the service-role client can
// delete an auth user).
const accountRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.delete("/account", { preHandler: fastify.authenticate }, async (request, reply) => {
    const { error } = await fastify.supabaseAdmin.auth.admin.deleteUser(request.user.id);

    if (error) {
      fastify.log.error({ error }, "account deletion failed");
      return reply.code(500).send({ message: "Failed to delete account. Please try again." });
    }

    return reply.code(204).send();
  });
};

export default accountRoutes;
