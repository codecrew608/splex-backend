import type { FastifyInstance } from "fastify";
import { type HandlerResult, ok, fail } from "./result.js";

// Real Razorpay subscription webhook handler — the fake checkout in
// billing.ts stays as-is; this establishes real state in the same
// subscriptions/users tables once Razorpay actually calls this endpoint.

const STATUS_VALUES = [
  "created",
  "authenticated",
  "active",
  "pending",
  "halted",
  "cancelled",
  "completed",
  "expired",
] as const;
type SubscriptionStatus = (typeof STATUS_VALUES)[number];

function isKnownStatus(value: unknown): value is SubscriptionStatus {
  return typeof value === "string" && (STATUS_VALUES as readonly string[]).includes(value);
}

// Entitlement is a deliberate function of Razorpay's OWN current status
// (the entity snapshot every event carries), not the event name — Razorpay
// itself recommends this: the event name says what triggered the webhook,
// the entity's status field is the single source of truth for state.
// authenticated/pending/created intentionally leave plan_tier untouched:
// authenticated means the mandate is authorized but no charge has
// necessarily succeeded yet, and pending means a retry window is in
// progress (Razorpay keeps trying for days before halting) — neither is
// "never grant" nor "instantly revoke," so the existing entitlement is
// left alone until the status resolves one way or the other.
function planTierForStatus(status: SubscriptionStatus): "pro" | "free" | null {
  if (status === "active") return "pro";
  if (status === "halted" || status === "cancelled" || status === "completed" || status === "expired") return "free";
  return null;
}

interface RazorpaySubscriptionEntity {
  id: string;
  plan_id: string;
  status: string;
  current_start?: number | null;
  current_end?: number | null;
  customer_id?: string | null;
  notes?: Record<string, unknown> | null;
}

interface RazorpayWebhookBody {
  event: string;
  created_at: number;
  payload?: {
    subscription?: { entity?: RazorpaySubscriptionEntity };
  };
}

function unixSecondsToIso(value: number | null | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;
}

// crypto.subtle (Web Crypto), not node:crypto — this file runs verbatim on
// both Fastify/Node and the Cloudflare Worker (routes/razorpay.ts and
// worker/routes/razorpay.ts both call processRazorpayWebhook directly), and
// Web Crypto is the one HMAC API guaranteed present on both without relying
// on the Worker's nodejs_compat flag for anything crypto-specific.
async function computeHmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// No node:crypto timingSafeEqual on this shared path (see above) — this is
// the standard manual substitute: always walk the full length of the
// longer string so a mismatch's position can't leak through response
// timing, only fold the result into equality/inequality at the end.
function timingSafeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < length; i++) {
    diff |= (i < a.length ? a.charCodeAt(i) : 0) ^ (i < b.length ? b.charCodeAt(i) : 0);
  }
  return diff === 0;
}

// Razorpay's own docs don't guarantee an x-razorpay-event-id header on
// every account/API version ("use it when available" per the spec this
// implements) — when absent, this composite stands in for it. It's stable
// across Razorpay's own retries of the *same* delivery: a retry resends
// the identical original payload, including its original created_at, so
// the same logical event always yields the same fallback key.
function fallbackEventId(body: RazorpayWebhookBody, entity: RazorpaySubscriptionEntity): string {
  return `${body.event}:${entity.id}:${entity.status}:${body.created_at}`;
}

export async function processRazorpayWebhook(
  fastify: FastifyInstance,
  rawBody: string,
  signatureHeader: string | null | undefined,
  eventIdHeader: string | null | undefined,
): Promise<HandlerResult> {
  const secret = fastify.config.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    fastify.log.error({}, "razorpay webhook rejected: RAZORPAY_WEBHOOK_SECRET is not configured");
    return fail("Webhook not configured.", 500);
  }
  if (!signatureHeader) {
    fastify.log.warn({}, "razorpay webhook rejected: missing signature header");
    return fail("Missing signature.", 400);
  }

  const expected = await computeHmacHex(secret, rawBody);
  if (!timingSafeEqual(expected, signatureHeader)) {
    fastify.log.warn({}, "razorpay webhook rejected: signature verification failed");
    return fail("Invalid signature.", 400);
  }

  let body: RazorpayWebhookBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    fastify.log.warn({}, "razorpay webhook rejected: invalid JSON body");
    return fail("Invalid JSON.", 400);
  }

  const entity = body.payload?.subscription?.entity;
  if (!entity) {
    // Verified, well-formed webhook for something other than a subscription
    // lifecycle event (the Razorpay Dashboard config can deliver other
    // event categories to the same URL) — ack it, there's nothing to do.
    fastify.log.info({ event: body.event }, "razorpay webhook: no subscription entity, skipping");
    return ok({ received: true, processed: false });
  }

  if (entity.plan_id !== fastify.config.RAZORPAY_STARTER_PLAN_ID) {
    fastify.log.info({ event: body.event, subscriptionId: entity.id }, "razorpay webhook: plan_id is not the Starter plan, skipping");
    return ok({ received: true, processed: false });
  }

  const razorpayEventId = eventIdHeader || fallbackEventId(body, entity);

  // Idempotency gate: atomic insert-and-detect-conflict on the existing
  // payment_events table's unique razorpay_event_id constraint, not a
  // read-then-write check — the latter would race two concurrent deliveries
  // of the same retried event.
  const { error: insertError } = await fastify.supabaseAdmin.from("payment_events").insert({
    razorpay_event_id: razorpayEventId,
    event_type: body.event,
    payload: body,
  });
  if (insertError) {
    if (insertError.code === "23505") {
      fastify.log.info({ event: body.event, subscriptionId: entity.id, razorpayEventId }, "razorpay webhook: duplicate delivery, already processed");
      return ok({ received: true, processed: false });
    }
    fastify.log.error({ err: insertError, event: body.event }, "razorpay webhook: failed to record event");
    return fail("Failed to record event.", 500);
  }

  if (!isKnownStatus(entity.status)) {
    fastify.log.warn({ event: body.event, subscriptionId: entity.id, status: entity.status }, "razorpay webhook: unrecognized status, skipping state change");
    return ok({ received: true, processed: false });
  }

  const userId = await resolveUserId(fastify, entity);
  if (!userId) {
    fastify.log.warn({ event: body.event, subscriptionId: entity.id }, "razorpay webhook: could not associate subscription with a SPLEX user, skipping");
    return ok({ received: true, processed: false });
  }

  const { data: existing, error: fetchError } = await fastify.supabaseAdmin
    .from("subscriptions")
    .select("last_event_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (fetchError) {
    fastify.log.error({ err: fetchError, event: body.event, subscriptionId: entity.id }, "razorpay webhook: failed to read existing subscription row");
    return fail("Failed to process event.", 500);
  }

  if (existing?.last_event_at && new Date(existing.last_event_at).getTime() >= body.created_at * 1000) {
    fastify.log.info({ event: body.event, subscriptionId: entity.id, userId }, "razorpay webhook: stale/out-of-order event, skipping state change");
    return ok({ received: true, processed: true });
  }

  const upsertRow: Record<string, unknown> = {
    user_id: userId,
    razorpay_subscription_id: entity.id,
    razorpay_plan_id: entity.plan_id,
    status: entity.status,
    current_start: unixSecondsToIso(entity.current_start),
    current_end: unixSecondsToIso(entity.current_end),
    last_event_at: unixSecondsToIso(body.created_at),
  };
  if (entity.customer_id) upsertRow.razorpay_customer_id = entity.customer_id;

  const { error: subError } = await fastify.supabaseAdmin.from("subscriptions").upsert(upsertRow, { onConflict: "user_id" });
  if (subError) {
    fastify.log.error({ err: subError, event: body.event, subscriptionId: entity.id, userId }, "razorpay webhook: failed to upsert subscription row");
    return fail("Failed to process event.", 500);
  }

  const planTier = planTierForStatus(entity.status);
  if (planTier) {
    const { error: userError } = await fastify.supabaseAdmin.from("users").update({ plan_tier: planTier }).eq("id", userId);
    if (userError) {
      fastify.log.error({ err: userError, event: body.event, subscriptionId: entity.id, userId }, "razorpay webhook: failed to update plan_tier");
      return fail("Failed to process event.", 500);
    }
  }

  fastify.log.info(
    { event: body.event, subscriptionId: entity.id, userId, status: entity.status, planTier },
    "razorpay webhook: processed",
  );
  return ok({ received: true, processed: true });
}

// Section 9's two trusted association paths, in priority order. Neither
// depends on trusting a client-submitted value: the local-row match is
// server-authoritative once a subscription is linked, and notes are read
// from Razorpay's own stored copy of what SPLEX set at subscription-
// creation time (not part of this endpoint) — never from anything the
// webhook caller supplies directly. If a future create-subscription flow
// hasn't stamped notes.splex_user_id or pre-created a local row yet, this
// correctly resolves to null and the caller fails safe.
//
// Resubscription safety: a user can move from one razorpay_subscription_id
// to another over time (cancelled/halted/expired -> resubscribed — see
// migration 0049). A LATE or duplicate-but-distinct event for the
// ABANDONED old subscription id still carries the same notes.splex_user_id
// (Razorpay preserves notes verbatim) and would otherwise resolve straight
// to this user via the fallback below, even though the local row has since
// moved on to a different subscription. Guarding on "the notes-resolved
// user's CURRENT row, if any, must not already point at a different
// subscription id" closes that — it's what stops a stale event about an
// abandoned subscription from clobbering the one the user actually has
// now (wrong status, wrong dates, or worse, wrong entitlement).
async function resolveUserId(fastify: FastifyInstance, entity: RazorpaySubscriptionEntity): Promise<string | null> {
  const { data: existingByRzp } = await fastify.supabaseAdmin
    .from("subscriptions")
    .select("user_id")
    .eq("razorpay_subscription_id", entity.id)
    .maybeSingle();
  if (existingByRzp?.user_id) return existingByRzp.user_id;

  const notedUserId = entity.notes?.splex_user_id;
  if (typeof notedUserId !== "string" || notedUserId.length === 0) return null;

  const { data: user } = await fastify.supabaseAdmin.from("users").select("id").eq("id", notedUserId).maybeSingle();
  if (!user?.id) return null;

  const { data: currentRow } = await fastify.supabaseAdmin
    .from("subscriptions")
    .select("razorpay_subscription_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (currentRow?.razorpay_subscription_id && currentRow.razorpay_subscription_id !== entity.id) {
    return null; // stale event for a subscription this user has since replaced — refuse, don't clobber
  }

  return user.id;
}
