import type { AuthedUser } from "../types/index.js";
import type { PlanTier } from "../shared-types.js";
import type { WorkerCtx } from "./context.js";

export type AuthResult = { ok: true; user: AuthedUser } | { ok: false; status: number; message: string };

// Direct port of plugins/auth.ts's logic — same two calls
// (auth.getUser(token), then the users-table lookup for plan_tier/org_id),
// same "client-sent user id is never trusted" rule. Only the input shape
// changes: a Fetch API Request's headers instead of a FastifyRequest's.
export async function authenticateWorker(request: Request, ctx: WorkerCtx): Promise<AuthResult> {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;

  if (!token) {
    return { ok: false, status: 401, message: "Unauthorized." };
  }

  const { data, error } = await ctx.supabaseAdmin.auth.getUser(token);
  if (error || !data.user) {
    return { ok: false, status: 401, message: "Unauthorized." };
  }

  const { data: userRow, error: userRowError } = await ctx.supabaseAdmin
    .from("users")
    .select("plan_tier, org_id, email")
    .eq("id", data.user.id)
    .single();

  if (userRowError || !userRow) {
    return { ok: false, status: 401, message: "Unauthorized." };
  }

  return {
    ok: true,
    user: {
      id: data.user.id,
      email: userRow.email as string,
      planTier: userRow.plan_tier as PlanTier,
      orgId: (userRow.org_id as string | null) ?? null,
    },
  };
}
