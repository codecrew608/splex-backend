import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkDualPeriodQuota } from "../src/entitlements/index.js";
import { estimateAudioRequestMinutes, MAX_AUDIO_MINUTES_PER_REQUEST, MAX_AUDIO_INPUT_WORDS } from "../src/audio/generate.js";

const SRC = join(import.meta.dirname, "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

// A predicate-aware in-memory table engine — unlike test/helpers/fakeFastify.ts's
// generic stub (which always resolves null/[] and is shared by four other
// suites that depend on that exact behavior), this one actually applies
// eq/in/neq/gte so the REAL join chain in entitlements/index.ts's
// fetchUsage (projects -> conversations -> messages/workflow_runs) can be
// proven correct against controlled fixture data, not just "doesn't
// crash". Scoped to this file only.
type Row = Record<string, unknown>;
function makeTables(tables: Record<string, Row[]>) {
  return {
    from: (table: string) => {
      const rows = tables[table] ?? [];
      let filtered = rows;
      let countMode = false;
      const api: Record<string, unknown> = {
        select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
          if (opts?.count) countMode = true;
          return api;
        },
        eq: (col: string, val: unknown) => {
          filtered = filtered.filter((r) => r[col] === val);
          return api;
        },
        in: (col: string, vals: unknown[]) => {
          filtered = filtered.filter((r) => vals.includes(r[col]));
          return api;
        },
        neq: (col: string, val: unknown) => {
          filtered = filtered.filter((r) => r[col] !== val);
          return api;
        },
        gte: (col: string, val: unknown) => {
          // Real timestamp comparison, not string lexicographic — a bare
          // "2026-08-29" fixture date and a "2026-08-29T00:00:00+05:30"
          // boundary are the same instant-ish but sort wrong as strings.
          filtered = filtered.filter((r) => new Date(r[col] as string).getTime() >= new Date(val as string).getTime());
          return api;
        },
        maybeSingle: async () => ({ data: filtered[0] ?? null, error: null }),
        then: (resolve: (v: { data: unknown; error: null; count?: number }) => unknown) =>
          resolve(countMode ? { data: null, error: null, count: filtered.length } : { data: filtered, error: null }),
      };
      return api;
    },
  };
}

function fastify(tables: Record<string, Row[]>) {
  return {
    supabaseAdmin: makeTables(tables),
    log: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
  } as never;
}

const planLimits = (rows: Array<{ plan_tier: string; counter_type: string; limit_amount: number | null }>) => rows;

describe("checkDualPeriodQuota — the new day+month capability ceiling gate", () => {
  it("allows when both daily and monthly usage are under their caps", async () => {
    const f = fastify({
      plan_limits: planLimits([
        { plan_tier: "pro", counter_type: "image_generations", limit_amount: 5 },
        { plan_tier: "pro", counter_type: "image_generations_monthly", limit_amount: 60 },
      ]),
      generated_media: [
        { user_id: "u1", kind: "image", status: "completed", created_at: "2026-08-29" },
      ],
    });
    const q = await checkDualPeriodQuota(f, "u1", "pro", "image_generations", "image_generations_monthly",
      { kind: "generated_media", mediaKind: "image", period: "day" },
      { kind: "generated_media", mediaKind: "image", period: "month" });
    expect(q.allowed).toBe(true);
    expect(q.dailyUsed).toBe(1);
    expect(q.monthlyUsed).toBe(1);
  });

  it("blocks on the DAILY cap even when comfortably under the monthly cap", async () => {
    const rows = Array.from({ length: 5 }, () => ({ user_id: "u1", kind: "image", status: "completed", created_at: "2026-08-29" }));
    const f = fastify({
      plan_limits: planLimits([
        { plan_tier: "pro", counter_type: "image_generations", limit_amount: 5 },
        { plan_tier: "pro", counter_type: "image_generations_monthly", limit_amount: 60 },
      ]),
      generated_media: rows,
    });
    const q = await checkDualPeriodQuota(f, "u1", "pro", "image_generations", "image_generations_monthly",
      { kind: "generated_media", mediaKind: "image", period: "day" },
      { kind: "generated_media", mediaKind: "image", period: "month" });
    expect(q.allowed).toBe(false);
    expect(q.dailyUsed).toBe(5);
    expect(q.dailyLimit).toBe(5);
  });

  it("blocks on the MONTHLY cap even with zero usage today — a user cannot bypass the month by waiting for a fresh day", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ user_id: "u1", kind: "image", status: "completed", created_at: `2026-08-${String((i % 27) + 1).padStart(2, "0")}` }));
    const f = fastify({
      plan_limits: planLimits([
        { plan_tier: "pro", counter_type: "image_generations", limit_amount: 5 },
        { plan_tier: "pro", counter_type: "image_generations_monthly", limit_amount: 60 },
      ]),
      generated_media: rows,
    });
    const q = await checkDualPeriodQuota(f, "u1", "pro", "image_generations", "image_generations_monthly",
      { kind: "generated_media", mediaKind: "image", period: "day" },
      { kind: "generated_media", mediaKind: "image", period: "month" });
    expect(q.allowed).toBe(false);
    expect(q.monthlyUsed).toBe(60);
  });

  it("fails CLOSED when the plan_limits row is simply missing, not treated as unlimited", async () => {
    const f = fastify({ plan_limits: [], generated_media: [] });
    const q = await checkDualPeriodQuota(f, "u1", "pro", "video_generations", "video_generations_monthly",
      { kind: "generated_media", mediaKind: "video", period: "day" },
      { kind: "generated_media", mediaKind: "video", period: "month" });
    expect(q.allowed).toBe(false);
  });

  it("a failed generation does not count against either cap", async () => {
    const f = fastify({
      plan_limits: planLimits([
        { plan_tier: "pro", counter_type: "image_generations", limit_amount: 5 },
        { plan_tier: "pro", counter_type: "image_generations_monthly", limit_amount: 60 },
      ]),
      generated_media: [
        { user_id: "u1", kind: "image", status: "failed", created_at: "2026-08-29" },
        { user_id: "u1", kind: "image", status: "failed", created_at: "2026-08-29" },
      ],
    });
    const q = await checkDualPeriodQuota(f, "u1", "pro", "image_generations", "image_generations_monthly",
      { kind: "generated_media", mediaKind: "image", period: "day" },
      { kind: "generated_media", mediaKind: "image", period: "month" });
    expect(q.dailyUsed).toBe(0);
    expect(q.allowed).toBe(true);
  });
});

describe("audio quota is duration-summed, not count-based", () => {
  it("a 10-second and a 5-minute clip do not count the same — minutes sum correctly", async () => {
    const f = fastify({
      plan_limits: planLimits([
        { plan_tier: "pro", counter_type: "audio_minutes", limit_amount: 10 },
        { plan_tier: "pro", counter_type: "audio_minutes_monthly", limit_amount: 100 },
      ]),
      generated_media: [
        { user_id: "u1", kind: "audio", status: "completed", created_at: "2026-08-29", duration_seconds: 10 },
        { user_id: "u1", kind: "audio", status: "completed", created_at: "2026-08-29", duration_seconds: 300 },
      ],
    });
    const q = await checkDualPeriodQuota(f, "u1", "pro", "audio_minutes", "audio_minutes_monthly",
      { kind: "generated_media_minutes", mediaKind: "audio", period: "day" },
      { kind: "generated_media_minutes", mediaKind: "audio", period: "month" });
    expect(q.dailyUsed).toBeCloseTo(310 / 60, 5);
    expect(q.allowed).toBe(true);
  });

  it("a null duration_seconds (pre-migration row) counts as 0, never as unknown/infinite", async () => {
    const f = fastify({
      plan_limits: planLimits([
        { plan_tier: "pro", counter_type: "audio_minutes", limit_amount: 10 },
        { plan_tier: "pro", counter_type: "audio_minutes_monthly", limit_amount: 100 },
      ]),
      generated_media: [{ user_id: "u1", kind: "audio", status: "completed", created_at: "2026-08-29", duration_seconds: null }],
    });
    const q = await checkDualPeriodQuota(f, "u1", "pro", "audio_minutes", "audio_minutes_monthly",
      { kind: "generated_media_minutes", mediaKind: "audio", period: "day" },
      { kind: "generated_media_minutes", mediaKind: "audio", period: "month" });
    expect(q.dailyUsed).toBe(0);
  });

  it("the request-level 5-minute estimate matches the documented 150 wpm rate", () => {
    expect(MAX_AUDIO_MINUTES_PER_REQUEST).toBe(5);
    const exactlyAtLimit = "word ".repeat(MAX_AUDIO_INPUT_WORDS).trim();
    const overLimit = "word ".repeat(MAX_AUDIO_INPUT_WORDS + 1).trim();
    expect(estimateAudioRequestMinutes(exactlyAtLimit)).toBeCloseTo(MAX_AUDIO_MINUTES_PER_REQUEST, 5);
    expect(estimateAudioRequestMinutes(overLimit)).toBeGreaterThan(MAX_AUDIO_MINUTES_PER_REQUEST);
  });
});

describe("vision and workflow_runs usage is counted via the projects -> conversations ownership chain", () => {
  const OWNER_TABLES = {
    projects: [
      { id: "p1", user_id: "u1" },
      { id: "p2", user_id: "u2" }, // a different user's project — must never be counted for u1
    ],
    conversations: [
      { id: "c1", project_id: "p1" },
      { id: "c2", project_id: "p2" },
    ],
  };

  it("vision_messages counts only THIS user's cortex_decisions rows with category='vision'", async () => {
    const f = fastify({
      ...OWNER_TABLES,
      messages: [
        { id: "m1", conversation_id: "c1" }, // belongs to u1
        { id: "m2", conversation_id: "c2" }, // belongs to u2
      ],
      cortex_decisions: [
        { id: "d1", message_id: "m1", category: "vision", created_at: "2026-08-29" },
        { id: "d2", message_id: "m1", category: "general", created_at: "2026-08-29" }, // not vision — excluded
        { id: "d3", message_id: "m2", category: "vision", created_at: "2026-08-29" }, // u2's — must not count for u1
      ],
      plan_limits: planLimits([
        { plan_tier: "pro", counter_type: "vision_inputs", limit_amount: 20 },
        { plan_tier: "pro", counter_type: "vision_inputs_monthly", limit_amount: 300 },
      ]),
    });
    const q = await checkDualPeriodQuota(f, "u1", "pro", "vision_inputs", "vision_inputs_monthly",
      { kind: "vision_messages", period: "day" },
      { kind: "vision_messages", period: "month" });
    expect(q.dailyUsed).toBe(1);
  });

  it("workflow_runs counts only THIS user's runs, reached via conversation ownership", async () => {
    const f = fastify({
      ...OWNER_TABLES,
      workflow_runs: [
        { id: "w1", conversation_id: "c1", created_at: "2026-08-29" }, // u1's
        { id: "w2", conversation_id: "c2", created_at: "2026-08-29" }, // u2's — must not count for u1
      ],
      plan_limits: planLimits([
        { plan_tier: "pro", counter_type: "workflow_runs", limit_amount: 3 },
        { plan_tier: "pro", counter_type: "workflow_runs_monthly", limit_amount: 30 },
      ]),
    });
    const q = await checkDualPeriodQuota(f, "u1", "pro", "workflow_runs", "workflow_runs_monthly",
      { kind: "workflow_runs", period: "day" },
      { kind: "workflow_runs", period: "month" });
    expect(q.dailyUsed).toBe(1);
  });

  it("a user with zero projects gets zero usage without erroring (short-circuits before the join)", async () => {
    const f = fastify({
      projects: [],
      plan_limits: planLimits([
        { plan_tier: "pro", counter_type: "workflow_runs", limit_amount: 3 },
        { plan_tier: "pro", counter_type: "workflow_runs_monthly", limit_amount: 30 },
      ]),
    });
    const q = await checkDualPeriodQuota(f, "brand-new-user", "pro", "workflow_runs", "workflow_runs_monthly",
      { kind: "workflow_runs", period: "day" },
      { kind: "workflow_runs", period: "month" });
    expect(q.dailyUsed).toBe(0);
    expect(q.allowed).toBe(true);
  });
});

describe("structural guards for the new premium ceilings are actually wired at their call sites", () => {
  // Source-text pins (same idiom as hardening.test.ts) proving the new
  // checks are reachable and in the right place — not just that the
  // underlying function is correct in isolation (proven above).

  it("chat.ts checks the vision ceiling only for non-Free tiers, before any provider spend", () => {
    const src = read("handlers/chat.ts");
    const guardAt = src.indexOf('if (user.planTier !== "free") {');
    const checkAt = src.indexOf('checkDualPeriodQuota(\n          fastify, user.id, user.planTier, "vision_inputs"');
    expect(guardAt).toBeGreaterThan(-1);
    expect(checkAt).toBeGreaterThan(guardAt);
    expect(checkAt - guardAt).toBeLessThan(400);
  });

  it("chat.ts rejects an over-length audio request before calling handleSyncMediaGeneration", () => {
    const src = read("handlers/chat.ts");
    const estimateAt = src.indexOf("estimateAudioRequestMinutes(classifierInputMessage) > MAX_AUDIO_MINUTES_PER_REQUEST");
    const generateAt = src.indexOf("kind: \"audio\", prompt: classifierInputMessage");
    expect(estimateAt).toBeGreaterThan(-1);
    expect(generateAt).toBeGreaterThan(estimateAt);
  });

  it("orchestrator.ts checks the workflow run-count ceiling before planWorkflow is ever called", () => {
    const src = read("cortex/workflow/orchestrator.ts");
    const quotaAt = src.indexOf('"workflow_runs", "workflow_runs_monthly"');
    const planAt = src.indexOf("await planWorkflow(fastify, message, contextBlock, limits.maxSteps, user.planTier)");
    expect(quotaAt).toBeGreaterThan(-1);
    expect(planAt).toBeGreaterThan(quotaAt);
  });

  it("checkMediaQuota routes audio through the duration-summed source, everything else through count", () => {
    const src = read("credits/mediaQuota.ts");
    expect(src).toContain('kind === "audio"');
    expect(src).toContain('"generated_media_minutes"');
  });
});
