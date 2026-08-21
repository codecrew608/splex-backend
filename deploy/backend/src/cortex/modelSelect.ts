import type { FastifyInstance } from "fastify";
import type { PlanTier, ComplexityLevel } from "../shared-types.js";
import type { ModelRegistryRow, ModelHealthRow } from "../types/index.js";
import { scoreModels, diversifyByProvider } from "./routing.js";

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
// Ranking is now cost-aware (see routing.ts): candidates are scored on
// quality x capability-fit x reliability x cost x latency using weights
// chosen by task shape, with live health data overriding configured
// reliability once enough observations exist. `priority` still orders the
// initial DB fetch (so a curated ordering seeds the pool) but no longer
// decides the winner on its own.
//
// Returns a ranked list (not just one row) so a caller can retry with the
// next candidate if the first hits a transient upstream failure — most
// relevant on the free tier, where OpenRouter's shared :free pool for a
// given model can get rate-limited independently of SPLEX's own traffic
// (observed live, repeatedly). The fallback candidate is preferentially
// from a DIFFERENT provider, since failures cluster by upstream provider.
// Same-variant fallback to "general" only if the category itself has no
// rows — never crosses free/paid.
export async function selectModelCandidates(
  fastify: FastifyInstance,
  category: string,
  planTier: PlanTier,
  limit = 2,
  complexity: ComplexityLevel = "medium",
): Promise<ModelRegistryRow[]> {
  const variant: "free" | "paid" = planTier === "free" ? "free" : "paid";

  let pool = await queryModelRegistry(fastify, category, variant, planTier);
  let effectiveCategory = category;
  if (pool.length === 0) {
    pool = await queryModelRegistry(fastify, "general", variant, planTier);
    effectiveCategory = "general";
  }
  if (pool.length === 0) return [];

  const health = await fetchHealth(fastify, pool.map((m) => m.id));
  const scored = scoreModels(pool, health, effectiveCategory, complexity);
  const picked = diversifyByProvider(scored, limit);

  fastify.log.debug(
    {
      category: effectiveCategory,
      planTier,
      complexity,
      // Model ids in server-side debug logs only — never leaves the backend.
      ranked: picked.map((s) => ({ model: s.model.openrouter_model_id, score: Math.round(s.score), ...s.breakdown })),
    },
    "cortex routing decision",
  );

  return picked.map((s) => s.model);
}

export async function selectModel(
  fastify: FastifyInstance,
  category: string,
  planTier: PlanTier,
  complexity: ComplexityLevel = "medium",
): Promise<ModelRegistryRow | null> {
  const [first] = await selectModelCandidates(fastify, category, planTier, 1, complexity);
  return first ?? null;
}
