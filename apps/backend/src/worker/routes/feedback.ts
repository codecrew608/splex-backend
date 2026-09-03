import { submitFeedback, feedbackBodySchema } from "../../handlers/feedback.js";
import type { WorkerCtx } from "../context.js";
import { asFastifyInstance } from "../context.js";
import type { AuthedUser } from "../../types/index.js";
import { respondWithResult, errorResponse, parseJsonBody } from "../http.js";

// HTTP adapter only — behaviour lives in handlers/feedback.ts, shared
// verbatim with routes/feedback.ts.
export async function handleSubmitFeedback(request: Request, ctx: WorkerCtx, user: AuthedUser, execCtx: ExecutionContext): Promise<Response> {
  const parsed = feedbackBodySchema.safeParse(await parseJsonBody(request));
  if (!parsed.success) {
    return errorResponse("Invalid request.", 400);
  }

  const result = await submitFeedback(asFastifyInstance(ctx), user, parsed.data, (work) => execCtx.waitUntil(work));
  return respondWithResult(result);
}
