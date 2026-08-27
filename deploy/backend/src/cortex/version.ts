import type { PlanTier } from "../shared-types.js";

// THE server-side Cortex engine version concept. Free -> v1 (baseline
// routing profile). Starter/Pro -> v1.5 (full cost/quality/health-aware
// routing — see routing.ts's version branch in scoreModels/pickCandidates).
// This is the ONLY place plan tier maps to engine version — every caller
// derives cortexVersion by calling this with the authenticated user's own
// planTier, never by accepting a version from the request body. There is
// deliberately no `cortex_version` column anywhere: version is 100%
// deterministic from plan_tier, so persisting it would just be a second,
// driftable copy of this function's return value.
export type CortexVersion = "v1" | "v1.5";

export function resolveCortexVersion(planTier: PlanTier): CortexVersion {
  return planTier === "free" ? "v1" : "v1.5";
}
