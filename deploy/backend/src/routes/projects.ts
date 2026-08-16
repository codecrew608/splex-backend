import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const createProjectSchema = z.object({
  title: z.string().trim().min(1).max(200),
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
const projectsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/projects", { preHandler: fastify.authenticate }, async (request, reply) => {
    const parsed = createProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "A project title is required." });
    }

    const [{ count }, { data: userRow }] = await Promise.all([
      fastify.supabaseAdmin.from("projects").select("id", { count: "exact", head: true }).eq("user_id", request.user.id),
      fastify.supabaseAdmin.from("users").select("plan_tier").eq("id", request.user.id).single(),
    ]);

    const planTier = userRow?.plan_tier ?? "free";
    const { data: limitRow } = await fastify.supabaseAdmin
      .from("plan_limits")
      .select("limit_amount")
      .eq("plan_tier", planTier)
      .eq("counter_type", "projects")
      .maybeSingle();

    const limit = limitRow?.limit_amount ?? null;
    if (limit !== null && (count ?? 0) >= limit) {
      return reply.code(403).send({ message: `Your plan allows up to ${limit} projects. Upgrade to create more.` });
    }

    const { data, error } = await fastify.supabaseAdmin
      .from("projects")
      .insert({ user_id: request.user.id, title: parsed.data.title, type: "chat" })
      .select("id, title, created_at")
      .single();

    if (error || !data) {
      fastify.log.error({ error }, "failed to create project");
      return reply.code(500).send({ message: "Failed to create project." });
    }

    return reply.code(201).send({ id: data.id, title: data.title, createdAt: data.created_at });
  });
};

export default projectsRoutes;
