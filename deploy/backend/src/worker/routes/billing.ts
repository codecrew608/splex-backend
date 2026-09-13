import { fakeCheckout, fakeCancel, createSubscription } from "../../handlers/billing.js";
import type { WorkerCtx } from "../context.js";
import { asFastifyInstance } from "../context.js";
import type { AuthedUser } from "../../types/index.js";
import { respondWithResult, parseJsonBody } from "../http.js";

// HTTP adapter only — behaviour lives in handlers/billing.ts, shared
// verbatim with routes/billing.ts.
export async function handleFakeCheckout(ctx: WorkerCtx, user: AuthedUser): Promise<Response> {
  return respondWithResult(await fakeCheckout(asFastifyInstance(ctx), user.id));
}

export async function handleFakeCancel(ctx: WorkerCtx, user: AuthedUser): Promise<Response> {
  return respondWithResult(await fakeCancel(asFastifyInstance(ctx), user.id));
}

export async function handleCreateSubscription(request: Request, ctx: WorkerCtx, user: AuthedUser): Promise<Response> {
  const body = (await parseJsonBody(request)) as { tier?: unknown } | undefined;
  const tier = body?.tier === "pro" ? "pro" : "starter";
  return respondWithResult(await createSubscription(asFastifyInstance(ctx), user.id, tier));
}
