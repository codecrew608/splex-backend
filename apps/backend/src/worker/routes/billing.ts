import { fakeCheckout, fakeCancel, createSubscription } from "../../handlers/billing.js";
import type { WorkerCtx } from "../context.js";
import { asFastifyInstance } from "../context.js";
import type { AuthedUser } from "../../types/index.js";
import { respondWithResult } from "../http.js";

// HTTP adapter only — behaviour lives in handlers/billing.ts, shared
// verbatim with routes/billing.ts.
export async function handleFakeCheckout(ctx: WorkerCtx, user: AuthedUser): Promise<Response> {
  return respondWithResult(await fakeCheckout(asFastifyInstance(ctx), user.id));
}

export async function handleFakeCancel(ctx: WorkerCtx, user: AuthedUser): Promise<Response> {
  return respondWithResult(await fakeCancel(asFastifyInstance(ctx), user.id));
}

export async function handleCreateSubscription(ctx: WorkerCtx, user: AuthedUser): Promise<Response> {
  return respondWithResult(await createSubscription(asFastifyInstance(ctx), user.id));
}
