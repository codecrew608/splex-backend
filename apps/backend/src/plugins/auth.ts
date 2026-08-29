import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { resolveAuthedUser, extractBearerToken } from "../auth/resolveUser.js";

// Verifies the caller's Supabase JWT and resolves their plan tier. The
// client-sent user id (if any is ever present in a body) is NEVER trusted —
// every downstream query in this backend must read request.user.id, which
// only this preHandler sets, and only after verification.
//
// The verification itself lives in auth/resolveUser.ts, shared verbatim
// with the Worker entry point so the two can never drift apart on the most
// security-critical decision the backend makes.
export default fp(async function authPlugin(fastify: FastifyInstance) {
  fastify.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    const token = extractBearerToken(request.headers.authorization);
    if (!token) {
      return reply.code(401).send({ message: "Unauthorized." });
    }

    const result = await resolveAuthedUser(fastify.supabaseAdmin, token);
    if (!result.ok) {
      return reply.code(401).send({ message: "Unauthorized." });
    }

    request.user = result.user;
  });
});

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
