import type { FastifyInstance } from "fastify";
import type { PlanTier, ComplexityLevel } from "@splex/shared-types";
import type { ModelRegistryRow, ModelHealthRow } from "../types/index.js";
import { scoreModels, pickCandidates } from "./routing.js";
import type { CortexVersion } from "./version.js";

// Candidate pool size fetched before scoring. Larger than the number
// actually returned so the router has real choice — scoring the same 2
// rows the old priority ordering would have picked anyway would make the
// cost/health signals decorative.
const CANDIDATE_POOL_SIZE = 12;

async function queryModelRegistry(
  fastify: FastifyInstance,
  category: string,
  variant: "free" | "paid",
  planTier: PlanTier,
): Promise<ModelRegistryRow[]> {
  const tierColumn = planTier === "free" ? "free_tier_allowed" : "pro_tier_allowed";

  const { data, error } = await fastify.supabaseAdmin
    .from("model_registry")
    .select("*")
    .eq("category", category)
    .eq("variant", variant)
    .eq("is_active", true)
    // Explicit per-tier entitlement flag (migration 0014) on top of the
    // existing variant isolation — lets a specific model be barred from a
    // tier without deleting the row or flipping is_active for everyone.
    .eq(tierColumn, true)
    .order("priority", { ascending: true })
    .limit(CANDIDATE_POOL_SIZE);

  if (error) {
    fastify.log.error({ error }, "model_registry query failed");
    return [];
  }
  return (data as ModelRegistryRow[] | null) ?? [];
}

// Health is a separate table (see migration 0014) and is strictly an
// optimization signal — if this lookup fails, routing proceeds on
// configured scores alone rather than failing the request.
async function fetchHealth(fastify: FastifyInstance, modelIds: string[]): Promise<Map<string, ModelHealthRow>> {
  if (modelIds.length === 0) return new Map();

  const { data, error } = await fastify.supabaseAdmin
    .from("model_health")
    .select("model_id, success_count, failure_count, timeout_count, total_latency_ms, total_cost_usd, last_failure_at")
    .in("model_id", modelIds);

  if (error || !data) {
    fastify.log.warn({ error }, "model_health lookup failed — routing on configured scores only");
    return new Map();
  }
  return new Map((data as ModelHealthRow[]).map((row) => [row.model_id, row]));
}

// THE entire mechanism that keeps free-tier traffic on OpenRouter's :free
// models and everyone else on the paid-but-cheap equivalents. variant is a
// straight function of planTier — there is no path here that lets a paid
// request see a variant='free' row or vice versa. Never cache across
// requests, never short-circuit this with a hardcoded model id.
//
// cortexVersion drives the ACTUAL scoring behavior (see routing.ts's
// scoreModels/pickCandidates — v1 and v1.5 use genuinely different weight
// profiles, health-blending, and fallback-diversification, not just a
// different pool size) and, unless the caller passes an explicit `limit`,
// how many ranked candidates come back: v1's "Basic fallback" returns 2,
// v1.5's "More fallback candidates" returns 3. An explicit `limit` (e.g.
// deep research's "just the single top pick") always overrides that
// default regardless of version — it's a distinct concern from fallback
// depth. `priority` still orders the initial DB fetch (so a curated
// ordering seeds the pool) but no longer decides the winner on its own.
//
// Returns a ranked list (not just one row) so a caller can retry with the
// next candidate if the first hits a transient upstream failure — most
// relevant on the free tier, where OpenRouter's shared :free pool for a
// given model can get rate-limited independently of SPLEX's own traffic
// (observed live, repeatedly). Same-variant fallback to "general" only if
// the category itself has no rows — never crosses free/paid.
export async function selectModelCandidates(
  fastify: FastifyInstance,
  category: string,
  planTier: PlanTier,
  cortexVersion: CortexVersion,
  complexity: ComplexityLevel = "medium",
  limit?: number,
): Promise<ModelRegistryRow[]> {
  const variant: "free" | "paid" = planTier === "free" ? "free" : "paid";
  const effectiveLimit = limit ?? (cortexVersion === "v1" ? 2 : 3);

  let pool = await queryModelRegistry(fastify, category, variant, planTier);
  let effectiveCategory = category;
  if (pool.length === 0) {
    pool = await queryModelRegistry(fastify, "general", variant, planTier);
    effectiveCategory = "general";
  }
  if (pool.length === 0) return [];

  const health = await fetchHealth(fastify, pool.map((m) => m.id));
  const scored = scoreModels(pool, health, effectiveCategory, complexity, cortexVersion);
  const picked = pickCandidates(scored, cortexVersion, effectiveLimit);

  // Final, independent safety guard — deliberately redundant with
  // queryModelRegistry's own `.eq("variant", variant)` filter above, not a
  // replacement for it. A Free request must NEVER reach a paid-variant
  // model, and that must hold even if a future bug elsewhere in this file
  // (a missing filter, a category-fallback edge case, a bad join) ever let
  // one slip into `picked` — real provider cost is on the line, so this
  // checks the actual, final, about-to-be-returned list one more time
  // rather than trusting that the earlier filter always worked. Logged as
  // an error (not silently dropped) because it should never actually
  // trigger — if it does, that's a real bug elsewhere worth knowing about
  // immediately, not a routine event.
  const safePicked =
    planTier === "free"
      ? picked.filter((s) => {
          if (s.model.variant === "free") return true;
          fastify.log.error(
            { category: effectiveCategory, planTier, modelId: s.model.id, variant: s.model.variant },
            "cost-safety guard: dropped a non-free-variant candidate from a Free-tier selection — this should be structurally impossible, investigate queryModelRegistry",
          );
          return false;
        })
      : picked;

  fastify.log.debug(
    {
      category: effectiveCategory,
      planTier,
      cortexVersion,
      complexity,
      // Model ids in server-side debug logs only — never leaves the backend.
      ranked: safePicked.map((s) => ({
        model: s.model.openrouter_model_id,
        variant: s.model.variant,
        score: Math.round(s.score),
        ...s.breakdown,
      })),
    },
    "cortex routing decision",
  );

  return safePicked.map((s) => s.model);
}

export async function selectModel(
  fastify: FastifyInstance,
  category: string,
  planTier: PlanTier,
  cortexVersion: CortexVersion,
  complexity: ComplexityLevel = "medium",
): Promise<ModelRegistryRow | null> {
  const [first] = await selectModelCandidates(fastify, category, planTier, cortexVersion, complexity, 1);
  return first ?? null;
}
