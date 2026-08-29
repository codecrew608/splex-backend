import type { FastifyInstance } from "fastify";
import type { PlanTier } from "../shared-types.js";
import { getQuotaState, type Capability } from "../entitlements/index.js";

// "Media" is a loose label at this point — web_search/deep_research
// produce no file, just billable work tracked the same way (see
// entitlements/index.ts's UsageSource comment for why this table is
// reused rather than duplicated for them).
export type MediaKind = "image" | "audio" | "video" | "ppt" | "web_search" | "deep_research";
export type MediaStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";

export interface MediaQuota {
  allowed: boolean;
  used: number;
  limit: number | null; // null = unlimited
}

// Thin adapter over the central entitlement service — the quota rules
// themselves (limit lookup, usage counting, IST day boundary, fail-closed
// on error) now live in exactly one place (entitlements/index.ts) rather
// than being duplicated here. Kept as its own function with an unchanged
// signature so the three media handlers that call it need no edits; every
// MediaKind is also a Capability by construction, so the mapping is an
// identity cast rather than another lookup table to keep in sync.
export async function checkMediaQuota(
  fastify: FastifyInstance,
  userId: string,
  planTier: PlanTier,
  kind: MediaKind,
): Promise<MediaQuota> {
  const state = await getQuotaState(fastify, userId, planTier, kind as Capability);
  return { allowed: state.allowed, used: state.used, limit: state.limit };
}

// "1 active concurrent generation" guardrail (spec, video specifically) —
// distinct from the daily quota: this blocks a *second* job while one is
// still queued/processing, regardless of how much of the day's quota
// remains. Generalized over kind (not video-only) since any future async
// kind (PPT, if it ends up job-based) needs the identical check.
export async function checkConcurrentMediaLimit(
  fastify: FastifyInstance,
  userId: string,
  kind: MediaKind,
  maxConcurrent: number,
): Promise<boolean> {
  const { count, error } = await fastify.supabaseAdmin
    .from("generated_media")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("kind", kind)
    .in("status", ["queued", "processing"]);

  if (error) {
    fastify.log.error({ error, userId, kind }, "generated_media concurrency check failed");
    return false;
  }
  return (count ?? 0) < maxConcurrent;
}

export interface GeneratedMediaRow {
  id: string;
  user_id: string;
  message_id: string | null;
  kind: MediaKind;
  status: MediaStatus;
  storage_path: string | null;
  prompt: string;
  provider_job_id: string | null;
  openrouter_model_id: string | null; // INTERNAL ONLY — never expose to the client (see routes/media.ts's response shape).
  cost_usd: number | null;
  credits_charged: number | null;
  error_message: string | null;
}

// Ownership-scoped by construction — callers always pass the requesting
// user's own id, never trust a client-supplied one alone (same pattern as
// fetchOwnedFiles). Returns null for "doesn't exist" and "exists but isn't
// yours" alike, so callers can't distinguish the two — the correct
// behavior for anything reachable from a client-facing route.
export async function getOwnedGeneratedMedia(
  fastify: FastifyInstance,
  userId: string,
  mediaId: string,
): Promise<GeneratedMediaRow | null> {
  const { data, error } = await fastify.supabaseAdmin
    .from("generated_media")
    .select(
      "id, user_id, message_id, kind, status, storage_path, prompt, provider_job_id, openrouter_model_id, cost_usd, credits_charged, error_message",
    )
    .eq("id", mediaId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !data) return null;
  return data as GeneratedMediaRow;
}

export async function updateGeneratedMediaStatus(
  fastify: FastifyInstance,
  mediaId: string,
  updates: {
    status: MediaStatus;
    storagePath?: string | null;
    costUsd?: number | null;
    creditsCharged?: number | null;
    errorMessage?: string | null;
    // Set once the job has actually been submitted and its assistant
    // message exists. The row is now created BEFORE submission (so the
    // credit reservation always has something to hang off — see migration
    // 0025), which means these three arrive on a later update rather than
    // at insert time.
    messageId?: string | null;
    providerJobId?: string | null;
    openrouterModelId?: string | null;
  },
): Promise<void> {
  const { error } = await fastify.supabaseAdmin
    .from("generated_media")
    .update({
      status: updates.status,
      storage_path: updates.storagePath ?? undefined,
      cost_usd: updates.costUsd ?? undefined,
      credits_charged: updates.creditsCharged ?? undefined,
      error_message: updates.errorMessage ?? undefined,
      message_id: updates.messageId ?? undefined,
      provider_job_id: updates.providerJobId ?? undefined,
      openrouter_model_id: updates.openrouterModelId ?? undefined,
      completed_at: updates.status === "completed" || updates.status === "failed" ? new Date().toISOString() : undefined,
    })
    .eq("id", mediaId);

  if (error) {
    fastify.log.error({ error, mediaId }, "failed to update generated_media status");
  }
}

export async function recordMediaGeneration(
  fastify: FastifyInstance,
  params: {
    userId: string;
    messageId: string | null;
    kind: MediaKind;
    status: MediaStatus;
    storagePath?: string | null;
    prompt: string;
    providerJobId?: string | null;
    openrouterModelId?: string | null;
    costUsd?: number | null;
    creditsCharged?: number | null;
    errorMessage?: string | null;
  },
): Promise<string | null> {
  const { data, error } = await fastify.supabaseAdmin
    .from("generated_media")
    .insert({
      user_id: params.userId,
      message_id: params.messageId,
      kind: params.kind,
      status: params.status,
      storage_path: params.storagePath ?? null,
      prompt: params.prompt,
      provider_job_id: params.providerJobId ?? null,
      openrouter_model_id: params.openrouterModelId ?? null,
      cost_usd: params.costUsd ?? null,
      credits_charged: params.creditsCharged ?? null,
      error_message: params.errorMessage ?? null,
      completed_at: params.status === "completed" ? new Date().toISOString() : null,
    })
    .select("id")
    .single();

  if (error || !data) {
    fastify.log.error({ error, userId: params.userId, kind: params.kind }, "failed to record generated_media row");
    return null;
  }
  return data.id as string;
}
