import type { FastifyInstance } from "fastify";
import { type HandlerResult, ok, fail } from "./result.js";
import { createRazorpaySubscription, RazorpayApiError } from "../razorpay/client.js";

// A subscription in any of these states is either live or already in the
// middle of being set up — creating a second one on top of it is exactly
// the duplicate the create-subscription flow must refuse.
const ACTIVE_OR_IN_FLIGHT_STATUSES = new Set(["created", "authenticated", "active", "pending"]);

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

// Real Razorpay subscription creation. Order matters here:
//  1. Cheap pre-check (fast, friendly error in the common non-race case,
//     avoids burning a Razorpay API call on a request that's certainly
//     going to be refused anyway).
//  2. Create the subscription on Razorpay's side — plan_id always comes
//     from server config, never the client, and the only trusted content
//     in `notes` is the ALREADY-authenticated user id this function was
//     called with.
//  3. Atomically claim the local slot (claim_subscription_slot, migration
//     0048) keyed on subscriptions.user_id's unique constraint — this,
//     not step 1, is what actually makes two simultaneous requests safe.
// If step 3 loses a race, the Razorpay-side subscription created in step 2
// is simply abandoned: nobody ever completes Checkout for it, so it can
// never charge anyone and needs no separate cleanup call.
export async function createSubscription(fastify: FastifyInstance, userId: string): Promise<HandlerResult> {
  const { data: existing, error: fetchError } = await fastify.supabaseAdmin
    .from("subscriptions")
    .select("status")
    .eq("user_id", userId)
    .maybeSingle();
  if (fetchError) {
    fastify.log.error({ fetchError }, "create-subscription: failed to check existing subscription");
    return fail("Couldn't start checkout. Please try again.", 500);
  }
  if (existing && ACTIVE_OR_IN_FLIGHT_STATUSES.has(existing.status as string)) {
    return fail("You already have a subscription in progress or active.", 409);
  }

  const planId = fastify.config.RAZORPAY_STARTER_PLAN_ID;
  let subscription: { id: string; status: string };
  try {
    subscription = await createRazorpaySubscription(fastify, planId, { splex_user_id: userId });
  } catch (err) {
    if (err instanceof RazorpayApiError) return fail(err.message, err.status);
    throw err;
  }

  const { data: claimedStatus, error: claimError } = await fastify.supabaseAdmin.rpc("claim_subscription_slot", {
    p_user_id: userId,
    p_razorpay_subscription_id: subscription.id,
    p_razorpay_plan_id: planId,
  });
  if (claimError) {
    fastify.log.error({ claimError, userId, subscriptionId: subscription.id }, "create-subscription: failed to claim local slot");
    return fail("Couldn't start checkout. Please try again.", 500);
  }
  if (!claimedStatus) {
    fastify.log.warn({ userId, subscriptionId: subscription.id }, "create-subscription: lost race, local slot already claimed");
    return fail("You already have a subscription in progress or active.", 409);
  }

  // Non-null: createRazorpaySubscription above already validated both
  // RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are set (it throws otherwise),
  // and config can't change mid-request — re-checking here would be dead
  // code the type system can't see is dead.
  return ok({ subscriptionId: subscription.id, keyId: fastify.config.RAZORPAY_KEY_ID! });
}
