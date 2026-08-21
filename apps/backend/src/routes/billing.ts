import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";

// Fake payment gateway — no real Razorpay (or any other) integration.
// Every checkout here succeeds immediately and synchronously; no money or
// external gateway is ever involved. Reuses the same `subscriptions`
// table shape a real gateway integration populated (fake IDs prefixed
// "fake_") so nothing else in the app — settings page, plan_tier gating,
// credit limits — needs to know the difference.
const BILLING_RATE_LIMIT = { max: 5, windowMs: 60_000 };

const billingRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    "/billing/fake-checkout",
    { preHandler: [fastify.authenticate, fastify.rateLimitByUser("billing_checkout", BILLING_RATE_LIMIT.max, BILLING_RATE_LIMIT.windowMs)] },
    async (request, reply) => {
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    const { error: subError } = await fastify.supabaseAdmin.from("subscriptions").upsert(
      {
        user_id: request.user.id,
        razorpay_customer_id: `fake_cus_${randomUUID()}`,
        razorpay_subscription_id: `fake_sub_${randomUUID()}`,
        razorpay_plan_id: "fake_plan_pro",
        status: "active",
        current_start: now.toISOString(),
        current_end: periodEnd.toISOString(),
      },
      { onConflict: "user_id" },
    );

    if (subError) {
      fastify.log.error({ subError }, "failed to persist fake subscription");
      return reply.code(500).send({ message: "Could not complete checkout. Please try again." });
    }

    const { error: userError } = await fastify.supabaseAdmin
      .from("users")
      .update({ plan_tier: "pro" })
      .eq("id", request.user.id);

    if (userError) {
      fastify.log.error({ userError }, "failed to flip plan_tier to pro");
      return reply.code(500).send({ message: "Could not complete checkout. Please try again." });
    }

    return reply.send({ status: "active", planTier: "pro" });
  });

  fastify.post(
    "/billing/fake-cancel",
    { preHandler: [fastify.authenticate, fastify.rateLimitByUser("billing_cancel", BILLING_RATE_LIMIT.max, BILLING_RATE_LIMIT.windowMs)] },
    async (request, reply) => {
    const { error: subError } = await fastify.supabaseAdmin
      .from("subscriptions")
      .update({ status: "cancelled" })
      .eq("user_id", request.user.id);

    if (subError) {
      fastify.log.error({ subError }, "failed to mark fake subscription cancelled");
    }

    const { error: userError } = await fastify.supabaseAdmin
      .from("users")
      .update({ plan_tier: "free" })
      .eq("id", request.user.id);

    if (userError) {
      fastify.log.error({ userError }, "failed to flip plan_tier to free");
      return reply.code(500).send({ message: "Could not cancel. Please try again." });
    }

    return reply.send({ status: "cancelled", planTier: "free" });
  });
};

export default billingRoutes;
