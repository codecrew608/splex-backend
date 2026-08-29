import type { FastifyInstance } from "fastify";
import type { PlanTier } from "@splex/shared-types";

// Every gated thing a user can do. Named capabilities rather than raw
// counter_type strings so call sites read as intent ("can this user
// generate a video?") and the counter_type mapping stays in exactly one
// place — this file. Adding a capability means adding it here and to
// CAPABILITY_CONFIG, nowhere else.
export type Capability =
  | "chat"
  | "workflow"
  | "image"
  | "video"
  | "audio"
  | "ppt"
  | "files"
  | "rag"
  | "projects"
  | "web_search"
  | "deep_research";

// generated_media's "kind" isn't file-download-specific despite the name —
// its actual semantics are "one row per unit of billable generation work,
// day-scoped, quota-checked, never counted if it failed" (see migration
// 0012's own comment). web_search/deep_research reuse it exactly that way:
// storage_path stays null (there's no file), prompt holds the query.
// Avoids a fourth near-identical tracking table.
type UsageSource =
  | { kind: "none" } // no quota — always allowed if the plan permits it at all
  | { kind: "generated_media"; mediaKind: "image" | "audio" | "video" | "ppt" | "web_search" | "deep_research"; period: "day" }
  | { kind: "usage_counters"; counterType: string; period: "day" | "month" }
  | { kind: "row_count"; table: "projects" | "files"; period: "all" | "month" };

interface CapabilityConfig {
  // plan_limits.counter_type this capability's cap lives under. null = the
  // capability has no numeric cap of its own (see `rag`).
  counterType: string | null;
  usage: UsageSource;
  label: string;
}

const CAPABILITY_CONFIG: Record<Capability, CapabilityConfig> = {
  chat: { counterType: "daily_requests", usage: { kind: "usage_counters", counterType: "daily_requests", period: "day" }, label: "Messages" },
  workflow: { counterType: "workflow_steps", usage: { kind: "none" }, label: "Agent Workflows" },
  image: { counterType: "image_generations", usage: { kind: "generated_media", mediaKind: "image", period: "day" }, label: "Images" },
  video: { counterType: "video_generations", usage: { kind: "generated_media", mediaKind: "video", period: "day" }, label: "Videos" },
  audio: { counterType: "audio_generations", usage: { kind: "generated_media", mediaKind: "audio", period: "day" }, label: "Audio" },
  ppt: { counterType: "ppt_generations", usage: { kind: "generated_media", mediaKind: "ppt", period: "day" }, label: "Presentations" },
  files: { counterType: "file_uploads", usage: { kind: "row_count", table: "files", period: "month" }, label: "File uploads" },
  projects: { counterType: "projects", usage: { kind: "row_count", table: "projects", period: "all" }, label: "Projects" },
  // No cap of its own — RAG is gated by whether the user has files at all
  // (see intelligence/retrieve.ts's existence check), not by a counter.
  rag: { counterType: null, usage: { kind: "none" }, label: "File context" },
  web_search: { counterType: "web_searches", usage: { kind: "generated_media", mediaKind: "web_search", period: "day" }, label: "Web searches" },
  deep_research: { counterType: "deep_research", usage: { kind: "generated_media", mediaKind: "deep_research", period: "day" }, label: "Deep research" },
};

export interface QuotaState {
  capability: Capability;
  label: string;
  used: number;
  // null = unlimited (matches plan_limits' own null-means-unlimited
  // convention, established for pro/daily_requests in migration 0011).
  limit: number | null;
  allowed: boolean;
}

// Day/month boundaries in Asia/Kolkata, matching the app's existing reset
// convention (enforce_file_limits() in migration 0011, and the media quota
// helper this consolidates).
function startOfTodayIST(): string {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  return `${ymd}T00:00:00+05:30`;
}

function startOfMonthIST(): string {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  return `${ymd.slice(0, 7)}-01T00:00:00+05:30`;
}

// Bare-date (not timestamp) equivalents, for exact-match filtering against
// usage_counters.period_start — a `date` column, not `timestamptz`. Written
// while extending this file for daily_credits (migration 0018) after
// noticing fetchUsage's usage_counters branch below only ever took the
// MOST RECENT row for a counter_type, with no period filter at all — fine
// for a monthly counter (one row a month, "most recent" is almost always
// "this month"), but wrong for any daily counter (credits.md's own
// check_daily_credits RPC gets this right with an explicit period_start
// match; this file's TS-side read didn't): on any day before a user's
// first action, the most recent row on file is YESTERDAY's, so both the
// usage panel and canUseCapability() would read yesterday's count as
// today's — silently over-restricting daily_requests (and would have done
// the same to daily_credits) rather than showing/enforcing a fresh zero.
function todayDateIST(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

function monthStartDateIST(): string {
  return `${todayDateIST().slice(0, 7)}-01`;
}

async function fetchLimit(fastify: FastifyInstance, planTier: PlanTier, counterType: string): Promise<number | null | undefined> {
  const { data, error } = await fastify.supabaseAdmin
    .from("plan_limits")
    .select("limit_amount")
    .eq("plan_tier", planTier)
    .eq("counter_type", counterType)
    .maybeSingle();

  if (error) {
    fastify.log.error({ error, planTier, counterType }, "plan_limits lookup failed");
    return undefined; // distinct from null (= unlimited) — caller fails closed
  }
  // No row at all is also "unknown", not "unlimited" — this is exactly the
  // bug migration 0012 fixed for pro/credits, where a missing row silently
  // read as 0/unlimited depending on the caller. Fail closed instead.
  if (!data) return undefined;
  return data.limit_amount as number | null;
}

async function fetchUsage(fastify: FastifyInstance, userId: string, source: UsageSource): Promise<number> {
  if (source.kind === "none") return 0;

  if (source.kind === "generated_media") {
    const { count, error } = await fastify.supabaseAdmin
      .from("generated_media")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("kind", source.mediaKind)
      // A failed generation is never charged and never counts against the
      // cap — same rule the credit system uses for failed completions.
      .neq("status", "failed")
      .gte("created_at", startOfTodayIST());
    if (error) {
      fastify.log.error({ error, userId, mediaKind: source.mediaKind }, "generated_media usage count failed");
      return Number.POSITIVE_INFINITY; // fail closed
    }
    return count ?? 0;
  }

  if (source.kind === "row_count") {
    let query = fastify.supabaseAdmin
      .from(source.table)
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);
    // Only REAL projects count against the cap. The auto-created container
    // behind every standalone chat is an implementation detail of the
    // NOT NULL conversations.project_id constraint, not something the user
    // chose to create — counting those meant an ordinary chat user blew
    // through a 3-project cap within a day and could never create a real
    // project again (observed live: 111 containers against an 8-project
    // history). See migration 0023.
    if (source.table === "projects") query = query.eq("is_implicit", false);
    if (source.period === "month") query = query.gte("created_at", startOfMonthIST());
    const { count, error } = await query;
    if (error) {
      fastify.log.error({ error, userId, table: source.table }, "row_count usage failed");
      return Number.POSITIVE_INFINITY;
    }
    return count ?? 0;
  }

  const currentPeriod = source.period === "day" ? todayDateIST() : monthStartDateIST();
  const { data, error } = await fastify.supabaseAdmin
    .from("usage_counters")
    .select("used")
    .eq("user_id", userId)
    .eq("counter_type", source.counterType)
    .eq("period_start", currentPeriod)
    .maybeSingle();
  if (error) {
    fastify.log.error({ error, userId, counterType: source.counterType }, "usage_counters lookup failed");
    return Number.POSITIVE_INFINITY;
  }
  // No row for the CURRENT period is a real, honest zero (no usage yet this
  // period) — not "unknown" the way a missing plan_limits row is. Only a
  // query error fails closed, per this function's existing convention.
  return (data?.used as number | undefined) ?? 0;
}

// THE single entitlement question. Every gate in the app should route
// through this rather than hand-rolling its own plan_limits query — that
// scattering is what let pro/credits silently read as "unlimited" in one
// place and "zero" in another before migration 0012.
//
// Fails CLOSED on any lookup error or missing limit row: an entitlement
// system that grants access when it can't verify is worse than one that
// occasionally denies a legitimate request.
export async function getQuotaState(
  fastify: FastifyInstance,
  userId: string,
  planTier: PlanTier,
  capability: Capability,
): Promise<QuotaState> {
  const config = CAPABILITY_CONFIG[capability];

  if (config.counterType === null) {
    return { capability, label: config.label, used: 0, limit: null, allowed: true };
  }

  const [limit, used] = await Promise.all([
    fetchLimit(fastify, planTier, config.counterType),
    fetchUsage(fastify, userId, config.usage),
  ]);

  if (limit === undefined) {
    return { capability, label: config.label, used: 0, limit: 0, allowed: false };
  }
  if (limit === null) {
    return { capability, label: config.label, used, limit: null, allowed: true };
  }
  return { capability, label: config.label, used, limit, allowed: used < limit };
}

export async function canUseCapability(
  fastify: FastifyInstance,
  userId: string,
  planTier: PlanTier,
  capability: Capability,
): Promise<boolean> {
  return (await getQuotaState(fastify, userId, planTier, capability)).allowed;
}

export async function getRemainingQuota(
  fastify: FastifyInstance,
  userId: string,
  planTier: PlanTier,
  capability: Capability,
): Promise<number | null> {
  const state = await getQuotaState(fastify, userId, planTier, capability);
  if (state.limit === null) return null; // unlimited
  return Math.max(0, state.limit - state.used);
}

export async function getCreditLimit(fastify: FastifyInstance, planTier: PlanTier): Promise<number | null | undefined> {
  return fetchLimit(fastify, planTier, "credits");
}

export async function getDailyLimit(
  fastify: FastifyInstance,
  planTier: PlanTier,
  capability: Capability,
): Promise<number | null | undefined> {
  const counterType = CAPABILITY_CONFIG[capability].counterType;
  if (counterType === null) return null;
  return fetchLimit(fastify, planTier, counterType);
}

// Capabilities surfaced in the UI's usage panel. Deliberately not every
// capability — `rag`/`workflow` have no per-day numeric cap worth showing,
// and `chat` is unlimited on Pro (its daily_requests limit is null), so it
// renders only when a real cap exists.
const UI_CAPABILITIES: Capability[] = ["image", "video", "audio", "ppt", "web_search", "deep_research", "files", "projects", "chat"];

export interface CreditBalance {
  used: number;
  limit: number | null;
  available: boolean;
}

export interface EntitlementSnapshot {
  planTier: PlanTier;
  credits: CreditBalance;
  dailyCredits: CreditBalance;
  quotas: QuotaState[];
}

// One round trip for the whole usage panel (see routes/entitlements.ts).
// Never includes model ids, provider names, or costs — this is a
// user-facing surface.
export async function getEntitlementSnapshot(
  fastify: FastifyInstance,
  userId: string,
  planTier: PlanTier,
): Promise<EntitlementSnapshot> {
  const [creditLimit, creditsUsed, dailyCreditLimit, dailyCreditsUsed, ...quotas] = await Promise.all([
    getCreditLimit(fastify, planTier),
    fetchUsage(fastify, userId, { kind: "usage_counters", counterType: "credits", period: "month" }),
    fetchLimit(fastify, planTier, "daily_credits"),
    // Reuses the same IST day-boundary usage_counters lookup pattern as
    // every other per-day quota in this file — see check_daily_credits'/
    // consume_daily_credits' own comment (migration 0018) for why IST
    // specifically, not UTC.
    fetchUsage(fastify, userId, { kind: "usage_counters", counterType: "daily_credits", period: "day" }),
    ...UI_CAPABILITIES.map((c) => getQuotaState(fastify, userId, planTier, c)),
  ]);

  return {
    planTier,
    credits: {
      used: Number.isFinite(creditsUsed) ? creditsUsed : 0,
      limit: creditLimit === undefined ? null : creditLimit,
      // False when the limit genuinely couldn't be resolved — the UI shows
      // "—" rather than inventing a percentage (spec: never falsely display
      // 100% remaining).
      available: creditLimit !== undefined,
    },
    dailyCredits: {
      used: Number.isFinite(dailyCreditsUsed) ? dailyCreditsUsed : 0,
      limit: dailyCreditLimit === undefined ? null : dailyCreditLimit,
      available: dailyCreditLimit !== undefined,
    },
    quotas: quotas as QuotaState[],
  };
}
