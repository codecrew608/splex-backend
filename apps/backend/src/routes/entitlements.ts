import type { FastifyPluginAsync } from "fastify";
import { getEntitlementSnapshot } from "../entitlements/index.js";

// GET /entitlements — the backend-authoritative usage/entitlement state
// the UI renders (spec section 21: "Frontend must consume the
// backend-authoritative entitlement state", and section 22's usage
// transparency panel). Deliberately server-computed rather than letting
// the client query plan_limits/generated_media directly: those reads were
// what allowed the frontend to draw its own (wrong) conclusions before,
// and generated_media is default-deny to the client anyway.
//
// Carries no model ids, provider names, or costs — capability labels and
// counts only.
const entitlementsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/entitlements", { preHandler: fastify.authenticate }, async (request, reply) => {
    const snapshot = await getEntitlementSnapshot(fastify, request.user.id, request.user.planTier);
    return reply.send(snapshot);
  });
};

export default entitlementsRoutes;
