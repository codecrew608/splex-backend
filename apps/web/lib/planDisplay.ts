import type { PlanTier } from "@splex/shared-types";

// Single source of truth for plan display names, so the mapping cannot
// drift per-component.
//
// TIER RENAME (2026-09-07). Until now the ₹299 plan used the enum value
// 'pro' while being shown as "Starter", and this function collapsed
// everything non-free to "Starter" accordingly. That is no longer safe:
// 'pro' now means SPLEX Pro (₹799), an entirely different product, and the
// old one-liner would have labelled a Pro subscriber "Starter".
//
// The enum now says what it means:
//     free    -> Free
//     starter -> Starter (₹299)
//     pro     -> Pro     (₹799, SPLEX Pro — not launched yet)
export function planDisplayName(planTier: PlanTier): "Free" | "Starter" | "Pro" {
  if (planTier === "free") return "Free";
  if (planTier === "pro") return "Pro";
  return "Starter";
}
