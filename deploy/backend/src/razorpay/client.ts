import type { FastifyInstance } from "fastify";

// Razorpay bills a subscription in a fixed number of cycles, not
// indefinitely — total_count is required by their Create Subscription API.
// 120 monthly cycles (10 years) is the standard "effectively indefinite,
// auto-renewing until the customer cancels" value for a monthly SaaS plan —
// nothing in SPLEX is time-boxed shorter than that, and Razorpay keeps
// billing every cycle until this count is exhausted or the subscription is
// cancelled, whichever comes first.
const SUBSCRIPTION_TOTAL_COUNT = 120;

export class RazorpayApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export interface RazorpaySubscription {
  id: string;
  status: string;
}

// Basic Auth over HTTPS, key_id:key_secret — Razorpay's own documented
// server-to-server auth for the Orders/Subscriptions REST API (distinct
// from the webhook's HMAC signature, which authenticates the OTHER
// direction). btoa, not Buffer — this file is intended to be Worker-
// portable like the rest of the Razorpay integration (see handlers/
// razorpay.ts's own crypto.subtle comment), and both key_id and key_secret
// are plain ASCII, which is exactly what btoa requires to be correct.
function authHeader(keyId: string, keySecret: string): string {
  return `Basic ${btoa(`${keyId}:${keySecret}`)}`;
}

// Server-to-server only — never called with anything the browser supplied.
// planId always comes from fastify.config.RAZORPAY_STARTER_PLAN_ID, notes
// always keyed off the authenticated request's own user id.
export async function createRazorpaySubscription(
  fastify: FastifyInstance,
  planId: string,
  notes: Record<string, string>,
): Promise<RazorpaySubscription> {
  const keyId = fastify.config.RAZORPAY_KEY_ID;
  const keySecret = fastify.config.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    fastify.log.error({}, "razorpay: RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET are not configured");
    throw new RazorpayApiError("Checkout is not available right now.", 500);
  }

  let response: Response;
  try {
    response = await fetch("https://api.razorpay.com/v1/subscriptions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader(keyId, keySecret),
      },
      body: JSON.stringify({
        plan_id: planId,
        total_count: SUBSCRIPTION_TOTAL_COUNT,
        customer_notify: 1,
        notes,
      }),
    });
  } catch (err) {
    fastify.log.error({ err: String(err) }, "razorpay: subscription creation request failed");
    throw new RazorpayApiError("Couldn't start checkout. Please try again.", 502);
  }

  if (!response.ok) {
    // Razorpay's error body is a safe, human-authored description (never a
    // secret or raw credential) — fine to log, never fine to forward
    // verbatim to the client, which gets a generic message instead.
    let description = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: { description?: string } };
      if (body.error?.description) description = body.error.description;
    } catch {
      // keep the HTTP-status-only description
    }
    fastify.log.error({ status: response.status, description }, "razorpay: subscription creation rejected");
    throw new RazorpayApiError("Couldn't start checkout. Please try again.", 502);
  }

  return (await response.json()) as RazorpaySubscription;
}
