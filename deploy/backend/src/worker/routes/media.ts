import { getMediaStatus } from "../../handlers/media.js";
import type { WorkerCtx } from "../context.js";
import { asFastifyInstance } from "../context.js";
import type { AuthedUser } from "../../types/index.js";
import { respondWithResult } from "../http.js";

// HTTP adapter only — behaviour lives in handlers/media.ts, shared verbatim
// with routes/media.ts.
export async function handleMediaStatus(mediaIdParam: string, ctx: WorkerCtx, user: AuthedUser): Promise<Response> {
  return respondWithResult(await getMediaStatus(asFastifyInstance(ctx), user.id, mediaIdParam));
}
