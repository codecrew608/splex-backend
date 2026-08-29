import type { AuthedUser } from "../types/index.js";
import type { WorkerCtx } from "./context.js";
import { resolveAuthedUser, extractBearerToken } from "../auth/resolveUser.js";

export type AuthResult = { ok: true; user: AuthedUser } | { ok: false; status: number; message: string };

// Thin adapter over the shared resolver — the verification rules live in
// auth/resolveUser.ts and are identical to the Fastify path by
// construction, not by hand-syncing. Only the input shape differs here: a
// Fetch API Request's headers instead of a FastifyRequest's.
export async function authenticateWorker(request: Request, ctx: WorkerCtx): Promise<AuthResult> {
  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) {
    return { ok: false, status: 401, message: "Unauthorized." };
  }

  const result = await resolveAuthedUser(ctx.supabaseAdmin, token);
  if (!result.ok) {
    return { ok: false, status: 401, message: "Unauthorized." };
  }

  return { ok: true, user: result.user };
}
