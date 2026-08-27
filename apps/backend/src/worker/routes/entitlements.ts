import { getEntitlementSnapshot } from "../../entitlements/index.js";
import type { WorkerCtx } from "../context.js";
import { asFastifyInstance } from "../context.js";
import type { AuthedUser } from "../../types/index.js";
import { jsonResponse } from "../http.js";

export async function handleGetEntitlements(ctx: WorkerCtx, user: AuthedUser): Promise<Response> {
  const snapshot = await getEntitlementSnapshot(asFastifyInstance(ctx), user.id, user.planTier);
  return jsonResponse(snapshot);
}
