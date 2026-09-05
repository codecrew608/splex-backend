import { processRazorpayWebhook } from "../../handlers/razorpay.js";
import type { WorkerCtx } from "../context.js";
import { asFastifyInstance } from "../context.js";
import { respondWithResult } from "../http.js";

// HTTP adapter only — behaviour lives in handlers/razorpay.ts, shared
// verbatim with routes/razorpay.ts. request.text() reads the raw body
// exactly once, before any JSON.parse — the Fetch API Request body can
// only be consumed a single time, so the handler parses this same string
// itself after verifying its signature.
export async function handleRazorpayWebhook(request: Request, ctx: WorkerCtx): Promise<Response> {
  const rawBody = await request.text();
  const signature = request.headers.get("x-razorpay-signature");
  const eventId = request.headers.get("x-razorpay-event-id");
  return respondWithResult(await processRazorpayWebhook(asFastifyInstance(ctx), rawBody, signature, eventId));
}
