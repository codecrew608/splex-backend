import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { PlanTier } from "../shared-types.js";

// Verifies the caller's Supabase JWT and resolves their plan tier. The
// client-sent user id (if any is ever present in a body) is NEVER trusted —
// every downstream query in this backend must read request.user.id, which
// only this preHandler sets, and only after verification.
export default fp(async function authPlugin(fastify: FastifyInstance) {
  fastify.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;

    if (!token) {
      return reply.code(401).send({ message: "Unauthorized." });
    }

    const { data, error } = await fastify.supabaseAdmin.auth.getUser(token);
    if (error || !data.user) {
      return reply.code(401).send({ message: "Unauthorized." });
    }

    const { data: userRow, error: userRowError } = await fastify.supabaseAdmin
      .from("users")
      .select("plan_tier, org_id, email")
      .eq("id", data.user.id)
      .single();

    if (userRowError || !userRow) {
      return reply.code(401).send({ message: "Unauthorized." });
    }

    request.user = {
      id: data.user.id,
      email: userRow.email as string,
      planTier: userRow.plan_tier as PlanTier,
      orgId: (userRow.org_id as string | null) ?? null,
    };
  });
});

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
