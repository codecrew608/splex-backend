import { deleteAccount, saveProfile, syncTimezone } from "../../handlers/account.js";
import type { WorkerCtx } from "../context.js";
import { asFastifyInstance } from "../context.js";
import type { AuthedUser } from "../../types/index.js";
import { parseJsonBody, respondWithResult } from "../http.js";

// HTTP adapter only — behaviour lives in handlers/account.ts, shared
// verbatim with routes/account.ts.
export async function handleDeleteAccount(ctx: WorkerCtx, user: AuthedUser): Promise<Response> {
  return respondWithResult(await deleteAccount(asFastifyInstance(ctx), user.id));
}

export async function handleSaveProfile(request: Request, ctx: WorkerCtx, user: AuthedUser): Promise<Response> {
  return respondWithResult(await saveProfile(asFastifyInstance(ctx), user.id, await parseJsonBody(request)));
}

export async function handleSyncTimezone(request: Request, ctx: WorkerCtx, user: AuthedUser): Promise<Response> {
  return respondWithResult(await syncTimezone(asFastifyInstance(ctx), user.id, await parseJsonBody(request)));
}
