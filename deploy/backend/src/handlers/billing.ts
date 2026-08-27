import type { FastifyInstance } from "fastify";
import { type HandlerResult, ok, fail } from "./result.js";

// Placeholder billing until Razorpay is wired up — flips plan_tier and
// records a subscription row so entitlements/quotas behave exactly as they
// will under real billing.
//
// Uses the GLOBAL crypto.randomUUID() rather than node:crypto's named
// import. That was the single genuine difference between the two previous
// copies of this logic, and the global form is correct on both runtimes:
// Workers exposes it as a standard, and Node has had it globally available
// since v19 (this repo requires >=22). So one implementation now serves
// both without a runtime shim.
function fakeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export async function fakeCheckout(fastify: FastifyInstance, userId: string): Promise<HandlerResult> {
  const now = new Date();
  const periodEnd = new Date(now);
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  const { error: subError } = await fastify.supabaseAdmin.from("subscriptions").upsert(
    {
      user_id: userId,
      razorpay_customer_id: fakeId("fake_cus"),
      razorpay_subscription_id: fakeId("fake_sub"),
      razorpay_plan_id: "fake_plan_pro",
      status: "active",
      current_start: now.toISOString(),
      current_end: periodEnd.toISOString(),
    },
    { onConflict: "user_id" },
  );

  if (subError) {
    fastify.log.error({ subError }, "failed to persist fake subscription");
    return fail("Could not complete checkout. Please try again.", 500);
  }

  const { error: userError } = await fastify.supabaseAdmin
    .from("users")
    .update({ plan_tier: "pro" })
    .eq("id", userId);

  if (userError) {
    fastify.log.error({ userError }, "failed to flip plan_tier to pro");
    return fail("Could not complete checkout. Please try again.", 500);
  }

  return ok({ status: "active", planTier: "pro" });
}

export async function fakeCancel(fastify: FastifyInstance, userId: string): Promise<HandlerResult> {
  // A failed subscription update is logged but NOT fatal — plan_tier is the
  // field entitlements actually reads, so downgrading the user matters more
  // than the bookkeeping row. Preserved exactly from both prior copies.
  const { error: subError } = await fastify.supabaseAdmin
    .from("subscriptions")
    .update({ status: "cancelled" })
    .eq("user_id", userId);

  if (subError) {
    fastify.log.error({ subError }, "failed to mark fake subscription cancelled");
  }

  const { error: userError } = await fastify.supabaseAdmin
    .from("users")
    .update({ plan_tier: "free" })
    .eq("id", userId);

  if (userError) {
    fastify.log.error({ userError }, "failed to flip plan_tier to free");
    return fail("Could not cancel. Please try again.", 500);
  }

  return ok({ status: "cancelled", planTier: "free" });
}
