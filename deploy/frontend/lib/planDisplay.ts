import type { PlanTier } from "@/shared-types";

// V1 has exactly two user-facing plans, Free and Starter (₹199/month). The
// internal plan_tier value stays "pro" (see migration 0018's own comment —
// renaming a live enum/column carries real migration risk for no user-
// facing benefit) but nothing in the UI should ever say "Pro" again. Single
// source of truth for that display mapping so it can't drift per-component.
export function planDisplayName(planTier: PlanTier): "Free" | "Starter" {
  return planTier === "free" ? "Free" : "Starter";
}
