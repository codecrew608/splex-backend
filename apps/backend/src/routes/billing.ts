import type { FastifyPluginAsync } from "fastify";
import Razorpay from "razorpay";

// Razorpay's Subscriptions API has no true "infinite, renews until
// cancelled" mode — total_count is mandatory. 120 monthly cycles (10 years)
// is the standard stand-in for "indefinite until the user cancels".
const INDEFINITE_MONTHLY_CYCLES = 120;

function razorpayClient(fastify: Parameters<FastifyPluginAsync>[0]) {
  return new Razorpay({
    key_id: fastify.config.RAZORPAY_KEY_ID,
    key_secret: fastify.config.RAZORPAY_KEY_SECRET,
  });
}

interface RazorpaySubscriptionWebhookEntity {
  id: string;
  status: string;
  current_start: number | null;
  current_end: number | null;
}

interface RazorpayWebhookPayload {
  event: string;
  payload?: {
    subscription?: { entity: RazorpaySubscriptionWebhookEntity };
  };
}

// Razorpay event -> {subscriptions.status, users.plan_tier}. 'pending' keeps
// plan_tier unchanged deliberately — it's a retry/grace period, not a hard
// failure; every other terminal state reverts the user to free.
const EVENT_MAP: Record<string, { status: string; planTier?: "free" | "pro" }> = {
  "subscription.activated": { status: "active", planTier: "pro" },
  "subscription.charged": { status: "active" },
  "subscription.pending": { status: "pending" },
  "subscription.halted": { status: "halted", planTier: "free" },
  "subscription.cancelled": { status: "cancelled", planTier: "free" },
  "subscription.completed": { status: "completed", planTier: "free" },
  "subscription.expired": { status: "expired", planTier: "free" },
};

const billingRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/billing/create-subscription", { preHandler: fastify.authenticate }, async (request, reply) => {
    const razorpay = razorpayClient(fastify);

    const { data: existing } = await fastify.supabaseAdmin
      .from("subscriptions")
      .select("razorpay_customer_id")
      .eq("user_id", request.user.id)
      .maybeSingle();

    let customerId = existing?.razorpay_customer_id as string | undefined;

    if (!customerId) {
      try {
        const customer = await razorpay.customers.create({
          email: request.user.email,
          fail_existing: 0,
        });
        customerId = customer.id;
      } catch (err) {
        fastify.log.error({ err }, "razorpay customer creation failed");
        return reply.code(502).send({ message: "Could not start checkout. Please try again." });
      }

      const { error: upsertError } = await fastify.supabaseAdmin
        .from("subscriptions")
        .upsert({ user_id: request.user.id, razorpay_customer_id: customerId }, { onConflict: "user_id" });

      if (upsertError) {
        fastify.log.error({ upsertError }, "failed to persist razorpay customer id");
        return reply.code(500).send({ message: "Could not start checkout. Please try again." });
      }
    }

    let subscription;
    try {
      subscription = await razorpay.subscriptions.create({
        plan_id: fastify.config.RAZORPAY_PRO_PLAN_ID,
        customer_notify: 1,
        total_count: INDEFINITE_MONTHLY_CYCLES,
        notes: { user_id: request.user.id },
      });
    } catch (err) {
      fastify.log.error({ err }, "razorpay subscription creation failed");
      return reply.code(502).send({ message: "Could not start checkout. Please try again." });
    }

    const { error: updateError } = await fastify.supabaseAdmin
      .from("subscriptions")
      .update({
        razorpay_subscription_id: subscription.id,
        razorpay_plan_id: fastify.config.RAZORPAY_PRO_PLAN_ID,
        status: "created",
      })
      .eq("user_id", request.user.id);

    if (updateError) {
      fastify.log.error({ updateError }, "failed to persist razorpay subscription id");
      return reply.code(500).send({ message: "Could not start checkout. Please try again." });
    }

    return reply.send({ subscriptionId: subscription.id, keyId: fastify.config.RAZORPAY_KEY_ID });
  });

  // NOT behind fastify.authenticate — Razorpay calls this directly. Auth is
  // HMAC signature verification over the raw body, not a Bearer token.
  fastify.post("/billing/webhook", async (request, reply) => {
    const signature = request.headers["x-razorpay-signature"];
    if (typeof signature !== "string" || !request.rawBody) {
      return reply.code(400).send({ message: "Missing signature." });
    }

    const valid = Razorpay.validateWebhookSignature(
      request.rawBody.toString("utf-8"),
      signature,
      fastify.config.RAZORPAY_WEBHOOK_SECRET,
    );
    if (!valid) {
      fastify.log.warn("razorpay webhook signature verification failed");
      return reply.code(400).send({ message: "Invalid signature." });
    }

    const body = request.body as RazorpayWebhookPayload;
    const eventId = request.headers["x-razorpay-event-id"];

    // Idempotency: on conflict (already-processed event), ignoreDuplicates
    // means no row comes back — treat that as "nothing to do".
    const { data: inserted, error: insertError } = await fastify.supabaseAdmin
      .from("payment_events")
      .upsert(
        { razorpay_event_id: String(eventId ?? `${body.event}:${Date.now()}`), event_type: body.event, payload: body },
        { onConflict: "razorpay_event_id", ignoreDuplicates: true },
      )
      .select("id");

    if (insertError) {
      fastify.log.error({ insertError }, "failed to record webhook event");
      return reply.code(500).send({ message: "Failed to process webhook." });
    }
    if (!inserted || inserted.length === 0) {
      return reply.code(200).send({ received: true, duplicate: true });
    }

    const mapping = EVENT_MAP[body.event];
    const entity = body.payload?.subscription?.entity;

    if (mapping && entity) {
      const { data: subRow } = await fastify.supabaseAdmin
        .from("subscriptions")
        .select("user_id")
        .eq("razorpay_subscription_id", entity.id)
        .maybeSingle();

      if (subRow?.user_id) {
        await fastify.supabaseAdmin
          .from("subscriptions")
          .update({
            status: mapping.status,
            current_start: entity.current_start ? new Date(entity.current_start * 1000).toISOString() : null,
            current_end: entity.current_end ? new Date(entity.current_end * 1000).toISOString() : null,
          })
          .eq("razorpay_subscription_id", entity.id);

        if (mapping.planTier) {
          await fastify.supabaseAdmin
            .from("users")
            .update({ plan_tier: mapping.planTier })
            .eq("id", subRow.user_id as string);
        }
      } else {
        fastify.log.warn({ subscriptionId: entity.id }, "webhook for unknown subscription id");
      }
    }

    return reply.code(200).send({ received: true });
  });
};

export default billingRoutes;
