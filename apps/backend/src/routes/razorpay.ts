import type { FastifyPluginAsync } from "fastify";
import { processRazorpayWebhook } from "../handlers/razorpay.js";
import { sendResult } from "./sendResult.js";

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// HTTP adapter only. Behaviour lives in handlers/razorpay.ts, shared
// verbatim with the Worker entry point (worker/routes/razorpay.ts). No
// fastify.authenticate here — Razorpay authenticates via signature, not a
// SPLEX session.
const razorpayRoutes: FastifyPluginAsync = async (fastify) => {
  // Scoped to this plugin's own encapsulated context only — every other
  // route keeps Fastify's default JSON body parsing untouched. Hands back
  // the raw string as request.body verbatim so the handler can verify the
  // HMAC signature against the exact bytes Razorpay sent — parsing to JSON
  // first and verifying against a re-stringified copy could byte-mismatch
  // what was actually signed.
  fastify.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });

  fastify.post("/webhooks/razorpay", async (request, reply) => {
    const rawBody = request.body;
    const result = await processRazorpayWebhook(
      fastify,
      typeof rawBody === "string" ? rawBody : "",
      headerString(request.headers["x-razorpay-signature"]),
      headerString(request.headers["x-razorpay-event-id"]),
    );
    return sendResult(reply, result);
  });
};

export default razorpayRoutes;
