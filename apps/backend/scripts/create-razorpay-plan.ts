// One-off setup script — run once real Razorpay keys exist, to create the
// recurring Pro plan (₹299/mo) via Razorpay's Plans API instead of
// manual dashboard clicking. Paste the returned plan id into
// RAZORPAY_PRO_PLAN_ID in apps/backend/.env.
//
// Usage: RAZORPAY_KEY_ID=... RAZORPAY_KEY_SECRET=... npx tsx scripts/create-razorpay-plan.ts
import Razorpay from "razorpay";

async function main() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    console.error("Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET before running this script.");
    process.exit(1);
  }

  const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });

  const plan = await razorpay.plans.create({
    period: "monthly",
    interval: 1,
    item: {
      name: "SPLEX Pro",
      amount: 29_900, // paise — ₹299.00
      currency: "INR",
      description: "SPLEX Pro plan — 1,000,000 credits/month",
    },
  });

  console.log(`Created plan: ${plan.id}`);
  console.log(`Set RAZORPAY_PRO_PLAN_ID=${plan.id} in apps/backend/.env`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
