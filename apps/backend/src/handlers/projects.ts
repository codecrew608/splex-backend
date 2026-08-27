import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PlanTier } from "@splex/shared-types";
import { getQuotaState } from "../entitlements/index.js";
import { type HandlerResult, ok, fail } from "./result.js";

export const createProjectSchema = z.object({
  title: z.string().trim().min(1).max(200),
  // Optional: the create form asks for it, but a project is perfectly
  // usable without one, so an empty description must never block creation.
  description: z.string().trim().max(2000).optional(),
});

// Rename/delete deliberately have NO backend route — RLS (`projects_owner_all`)
// already grants the owner full CRUD directly via the Supabase browser
// client, so a backend route for those would just duplicate what RLS already
// enforces correctly. Only creation needs one, because it's the one place
// worth keeping server-side validation (title length, and the plan's
// project-count cap) centralized.
//
// The project-count cap is enforced here, not via a DB trigger like
// files/storage — unlike a file-storage bypass (real Supabase Storage
// cost), a user who somehow bypassed this could only ever create more rows
// scoped to their own account (RLS still fully isolates them from everyone
// else's data), so the blast radius is "self-directed clutter," not a
// security or billing boundary.
//
// Deliberately does NOT apply to the auto-created container every plain
// "New chat" gets (persistence/conversations.ts's resolveConversation) —
// that path is an implementation detail of the NOT NULL project_id
// constraint, not the user-facing "project" the pricing page means, and
// capping it would lock free users out of ordinary chat. Those rows carry
// is_implicit=true and are excluded from the quota count itself (see
// entitlements/index.ts).
export async function createProject(
  fastify: FastifyInstance,
  userId: string,
  planTier: PlanTier,
  rawBody: unknown,
): Promise<HandlerResult> {
  const parsed = createProjectSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("A project title is required.", 400);
  }

  // Routed through the central entitlement service rather than a local
  // plan_limits query — same rules, one implementation.
  const quota = await getQuotaState(fastify, userId, planTier, "projects");
  if (!quota.allowed) {
    return fail(`Your plan allows up to ${quota.limit} projects. Upgrade to create more.`, 403);
  }

  // is_implicit:false is what makes this a REAL project — the one the
  // Projects list shows and the quota above counts. See migration 0023.
  const { data, error } = await fastify.supabaseAdmin
    .from("projects")
    .insert({
      user_id: userId,
      title: parsed.data.title,
      description: parsed.data.description || null,
      type: "chat",
      is_implicit: false,
    })
    .select("id, title, description, created_at")
    .single();

  if (error || !data) {
    fastify.log.error({ error }, "failed to create project");
    return fail("Failed to create project.", 500);
  }

  return ok({ id: data.id, title: data.title, description: data.description, createdAt: data.created_at }, 201);
}
