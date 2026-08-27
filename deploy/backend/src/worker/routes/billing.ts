import type { WorkerCtx } from "../context.js";
import type { AuthedUser } from "../../types/index.js";
import { jsonResponse } from "../http.js";

// Direct port of routes/billing.ts — still the same fake gateway (no real
// Razorpay/payment integration), same `subscriptions` upsert shape. Only
// change: node:crypto's randomUUID -> the Web Crypto global (native on
// Workers, no compat flag needed).
export async function handleFakeCheckout(ctx: WorkerCtx, user: AuthedUser): Promise<Response> {
  const now = new Date();
  const periodEnd = new Date(now);
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  const { error: subError } = await ctx.supabaseAdmin.from("subscriptions").upsert(
    {
      user_id: user.id,
      razorpay_customer_id: `fake_cus_${crypto.randomUUID()}`,
      razorpay_subscription_id: `fake_sub_${crypto.randomUUID()}`,
      razorpay_plan_id: "fake_plan_pro",
      status: "active",
      current_start: now.toISOString(),
      current_end: periodEnd.toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (subError) {
    ctx.log.error({ subError }, "failed to persist fake subscription");
    return jsonResponse({ message: "Could not complete checkout. Please try again." }, 500);
  }

  const { error: userError } = await ctx.supabaseAdmin.from("users").update({ plan_tier: "pro" }).eq("id", user.id);
  if (userError) {
    ctx.log.error({ userError }, "failed to flip plan_tier to pro");
    return jsonResponse({ message: "Could not complete checkout. Please try again." }, 500);
  }

  return jsonResponse({ status: "active", planTier: "pro" });
}

export async function handleFakeCancel(ctx: WorkerCtx, user: AuthedUser): Promise<Response> {
  const { error: subError } = await ctx.supabaseAdmin
    .from("subscriptions")
    .update({ status: "cancelled" })
    .eq("user_id", user.id);
  if (subError) {
    ctx.log.error({ subError }, "failed to mark fake subscription cancelled");
  }

  const { error: userError } = await ctx.supabaseAdmin.from("users").update({ plan_tier: "free" }).eq("id", user.id);
  if (userError) {
    ctx.log.error({ userError }, "failed to flip plan_tier to free");
    return jsonResponse({ message: "Could not cancel. Please try again." }, 500);
  }

  return jsonResponse({ status: "cancelled", planTier: "free" });
}
