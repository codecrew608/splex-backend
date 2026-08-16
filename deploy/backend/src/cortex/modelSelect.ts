import type { FastifyInstance } from "fastify";
import type { PlanTier } from "../shared-types.js";
import type { ModelRegistryRow } from "../types/index.js";

async function queryModelRegistryRanked(
  fastify: FastifyInstance,
  category: string,
  variant: "free" | "paid",
  limit: number,
): Promise<ModelRegistryRow[]> {
  const { data, error } = await fastify.supabaseAdmin
    .from("model_registry")
    .select("*")
    .eq("category", category)
    .eq("variant", variant)
    .eq("is_active", true)
    .order("priority", { ascending: true })
    .order("capability_score", { ascending: false })
    .limit(limit);

  if (error) {
    fastify.log.error({ error }, "model_registry query failed");
    return [];
  }
  return (data as ModelRegistryRow[] | null) ?? [];
}

// THE entire mechanism that keeps free-tier traffic on OpenRouter's :free
// models and everyone else on the paid-but-cheap equivalents. variant is a
// straight function of planTier — there is no path here that lets a paid
// request see a variant='free' row or vice versa. Never cache across
// requests, never short-circuit this with a hardcoded model id.
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
  limit = 2,
): Promise<ModelRegistryRow[]> {
  const variant: "free" | "paid" = planTier === "free" ? "free" : "paid";

  const exact = await queryModelRegistryRanked(fastify, category, variant, limit);
  if (exact.length > 0) return exact;

  return queryModelRegistryRanked(fastify, "general", variant, limit);
}

export async function selectModel(
  fastify: FastifyInstance,
  category: string,
  planTier: PlanTier,
): Promise<ModelRegistryRow | null> {
  const [first] = await selectModelCandidates(fastify, category, planTier, 1);
  return first ?? null;
}
