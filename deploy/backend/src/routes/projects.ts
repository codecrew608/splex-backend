import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getQuotaState } from "../entitlements/index.js";

const createProjectSchema = z.object({
  title: z.string().trim().min(1).max(200),
  // Optional: the create form asks for it, but a project is perfectly
  // usable without one, so an empty description must never block creation.
  description: z.string().trim().max(2000).optional(),
});

// Rename/delete deliberately have NO backend route — RLS (`projects_owner_all`)
// already grants the owner full CRUD directly via the Supabase browser
// client, so a backend route for those would just duplicate what RLS already
// enforces correctly. Only creation needs a backend route, because it's the
// one place worth keeping server-side validation (title length, and now the
// plan's project-count cap) centralized.
//
// The project-count cap is enforced here, not via a DB trigger like
// files/storage — unlike a file-storage bypass (real Supabase Storage
// cost), a user who somehow bypassed this could only ever create more rows
// scoped to their own account (RLS still fully isolates them from everyone
// else's data), so the blast radius is "self-directed clutter," not a
// security or billing boundary. Also deliberately does NOT apply to the
// auto-created 1:1 project every plain "New chat" gets
// (persistence/conversations.ts's resolveConversation) — that path is an
// implementation detail, not the user-facing "project" the pricing page
// means, and capping it would lock free users out of ordinary chat after
// 3 conversations ever.
const CREATE_RATE_LIMIT = { max: 10, windowMs: 60_000 };

const projectsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    "/projects",
    { preHandler: [fastify.authenticate, fastify.rateLimitByUser("projects_create", CREATE_RATE_LIMIT.max, CREATE_RATE_LIMIT.windowMs)] },
    async (request, reply) => {
    const parsed = createProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "A project title is required." });
    }

    // Routed through the central entitlement service rather than a local
    // plan_limits query — same rules, one implementation. request.user
    // already carries the authenticated plan tier (see plugins/auth.ts),
    // so the separate users lookup this used to do is redundant.
    const quota = await getQuotaState(fastify, request.user.id, request.user.planTier, "projects");
    if (!quota.allowed) {
      return reply
        .code(403)
        .send({ message: `Your plan allows up to ${quota.limit} projects. Upgrade to create more.` });
    }

    // is_implicit:false is what makes this a REAL project — the one the
    // Projects list shows and the quota above counts. The auto-created
    // container behind a standalone chat sets it true instead (see
    // persistence/conversations.ts and migration 0023).
    const { data, error } = await fastify.supabaseAdmin
      .from("projects")
      .insert({
        user_id: request.user.id,
        title: parsed.data.title,
        description: parsed.data.description || null,
        type: "chat",
        is_implicit: false,
      })
      .select("id, title, description, created_at")
      .single();

    if (error || !data) {
      fastify.log.error({ error }, "failed to create project");
      return reply.code(500).send({ message: "Failed to create project." });
    }

    return reply
      .code(201)
      .send({ id: data.id, title: data.title, description: data.description, createdAt: data.created_at });
  });
};

export default projectsRoutes;
