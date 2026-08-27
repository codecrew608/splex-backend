import { z } from "zod";
import { getQuotaState } from "../../entitlements/index.js";
import type { WorkerCtx } from "../context.js";
import { asFastifyInstance } from "../context.js";
import type { AuthedUser } from "../../types/index.js";
import { jsonResponse, errorResponse } from "../http.js";

const createProjectSchema = z.object({
  title: z.string().trim().min(1).max(200),
  // Optional: the create form asks for it, but a project is perfectly
  // usable without one, so an empty description must never block creation.
  description: z.string().trim().max(2000).optional(),
});

export async function handleCreateProject(request: Request, ctx: WorkerCtx, user: AuthedUser): Promise<Response> {
  const parsed = createProjectSchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) {
    return errorResponse("A project title is required.", 400);
  }

  const quota = await getQuotaState(asFastifyInstance(ctx), user.id, user.planTier, "projects");
  if (!quota.allowed) {
    return errorResponse(`Your plan allows up to ${quota.limit} projects. Upgrade to create more.`, 403);
  }

  // is_implicit:false — a REAL project, unlike the auto-created container
  // behind each standalone chat. See migration 0023 and routes/projects.ts,
  // which this mirrors exactly.
  const { data, error } = await ctx.supabaseAdmin
    .from("projects")
    .insert({
      user_id: user.id,
      title: parsed.data.title,
      description: parsed.data.description || null,
      type: "chat",
      is_implicit: false,
    })
    .select("id, title, description, created_at")
    .single();

  if (error || !data) {
    ctx.log.error({ error }, "failed to create project");
    return errorResponse("Failed to create project.", 500);
  }

  return jsonResponse({ id: data.id, title: data.title, description: data.description, createdAt: data.created_at }, 201);
}
