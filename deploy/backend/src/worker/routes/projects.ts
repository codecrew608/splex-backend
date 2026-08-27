import { createProject } from "../../handlers/projects.js";
import type { WorkerCtx } from "../context.js";
import { asFastifyInstance } from "../context.js";
import type { AuthedUser } from "../../types/index.js";
import { parseJsonBody, respondWithResult } from "../http.js";

// HTTP adapter only — behaviour lives in handlers/projects.ts, shared
// verbatim with routes/projects.ts.
export async function handleCreateProject(request: Request, ctx: WorkerCtx, user: AuthedUser): Promise<Response> {
  return respondWithResult(
    await createProject(asFastifyInstance(ctx), user.id, user.planTier, await parseJsonBody(request)),
  );
}
