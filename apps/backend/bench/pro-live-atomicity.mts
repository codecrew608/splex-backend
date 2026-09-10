/**
 * LIVE Postgres atomicity probe for the SPLEX Pro credit / budget
 * reservation path — hardening spec follow-up #1.
 *
 * WHY this exists: the in-process suite (test/pro-concurrency.test.ts)
 * proves the ENGINE's logic under Promise.all, but a JS microtask queue is
 * not a Postgres row lock. This runs the SAME real code
 * (src/pro/execution.ts + src/pro/orchestrator.ts, unmodified) against the
 * REAL production Postgres, firing genuinely concurrent requests, and
 * checks the real usage_counters / pro_budget_reservations /
 * pro_provider_runs / credit_usage_logs rows afterwards.
 *
 * SAFETY:
 *  - Creates its OWN brand-new synthetic user (random UUID,
 *    plan_tier='pro', no org). It never reads, writes, or touches any
 *    real user, the existing benchmark account, or production balances.
 *  - Every provider call is a local scripted mock — no network, no spend,
 *    no API key needed.
 *  - Hard-deletes everything it created in a finally block: pro_workflows
 *    for the synthetic user (cascades pro_tasks / pro_budget_reservations
 *    / pro_provider_runs / pro_artifacts / ...), then the user row itself
 *    (cascades usage_counters + credit_usage_logs).
 *  - SPLEX_PRO_ENABLED is forced true ONLY in this process's in-memory
 *    config object — the DB flag, wrangler.jsonc, and the deployed Worker
 *    are untouched.
 *
 * Run:  npx tsx bench/pro-live-atomicity.mts
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { buildWorkerCtx, asFastifyInstance } from "../src/worker/context.js";
import { createProWorkflow } from "../src/pro/orchestrator.js";
import { executeWorkflowStep, cancelProWorkflow } from "../src/pro/execution.js";
import type { AIProvider, ProviderCapabilities } from "../src/pro/providerCore.js";
import { ProviderCallError } from "../src/pro/providerCore.js";
import type { AuthedUser } from "../src/types/index.js";

// ---------------------------------------------------------------------------
function loadEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const ENV_FILE = process.env.SPLEX_ENV_FILE ?? `${process.env.HOME}/Desktop/Splex/apps/backend/.env`;
const merged = { ...loadEnv(ENV_FILE), ...process.env } as Record<string, string | undefined>;
// Drop empty-string values: the Worker env schema marks the 5 provider
// keys `.string().min(1).optional()`, so "" is present-but-invalid rather
// than absent. This probe uses only mock providers, so unset is correct.
const raw: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries(merged)) if (v !== "" && v != null) raw[k] = v;

const ctx = buildWorkerCtx(raw);
// In-memory only. The DB flag and the deployed Worker are not touched.
(ctx.config as { SPLEX_PRO_ENABLED: boolean }).SPLEX_PRO_ENABLED = true;
const fastify = asFastifyInstance(ctx);
const db = ctx.supabaseAdmin;
const CREDITS_PER_USD = ctx.config.CREDITS_PER_USD ?? 120_000;

// ---------------------------------------------------------------------------
let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail = "") {
  (cond ? (pass++, undefined) : (fail++, failures.push(label)));
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? `   [${detail}]` : ""}`);
}

// ---------------------------------------------------------------------------
const CAPS: ProviderCapabilities = {
  operations: ["plan", "reason", "generate", "analyze", "review", "research", "code", "tool_call"],
  modalities: ["text"],
  toolSupport: true,
  maxContextTokens: 128_000,
  costPerMillionInputUsd: 1,
  costPerMillionOutputUsd: 3,
};

type Beh = { kind: "ok"; costUsd?: number; delayMs?: number } | { kind: "throw"; cls: ProviderCallError["classification"]; delayMs?: number };

function scripted(name: AIProvider["name"], fallback: Beh, perCall: Beh[] = []): AIProvider {
  let i = 0;
  return {
    name,
    capabilities: CAPS,
    supports: (op) => CAPS.operations.includes(op),
    async call(params) {
      const b = perCall[i++] ?? fallback;
      if (b.delayMs) await new Promise((r) => setTimeout(r, b.delayMs));
      if (b.kind === "throw") throw new ProviderCallError(name, b.cls, `scripted ${b.cls}`);
      const content = `[${name}:${params.operation}] ok`;
      return {
        content,
        model: `${name}-model`,
        inputTokens: Math.ceil(params.input.length / 4),
        outputTokens: Math.ceil(content.length / 4),
        costUsd: b.costUsd ?? 0.005,
        latencyMs: 1,
      };
    },
  };
}
const okRegistry = () => [scripted("openai", { kind: "ok", costUsd: 0.005 })];

const OBJECTIVE = "Research, architect, implement, review and verify a tiny rate limiter."; // ~15 tokens -> optimizer bypasses, no network

// ---------------------------------------------------------------------------
let USER_ID = "";
function user(): AuthedUser {
  return { id: USER_ID, email: `pro-atomicity-${USER_ID.slice(0, 8)}@splex-benchmark.invalid`, planTier: "pro", orgId: null, timezone: "UTC" };
}

async function monthlyUsed(): Promise<number> {
  const { data: period } = await db.rpc("get_period_start", { p_counter_type: "credits", p_user_id: USER_ID });
  const { data } = await db.from("usage_counters").select("used").eq("user_id", USER_ID).eq("counter_type", "credits").eq("period_start", period as string).maybeSingle();
  return (data as { used: number } | null)?.used ?? 0;
}
async function dailyRowCount(): Promise<number> {
  // Both the daily CREDIT pool and the daily message-COUNT cap — Pro must
  // touch neither.
  const { data } = await db.from("usage_counters").select("counter_type, period_start, used").eq("user_id", USER_ID).in("counter_type", ["daily_credits", "daily_requests"]);
  const rows = (data ?? []) as Array<{ counter_type: string; period_start: string; used: number }>;
  const dirty = rows.filter((r) => (r.used ?? 0) > 0);
  if (dirty.length) console.log("     daily rows present:", JSON.stringify(dirty));
  return dirty.length;
}
async function ledgerRows(): Promise<Array<{ credits_consumed: number; intent: string }>> {
  const { data } = await db.from("credit_usage_logs").select("credits_consumed, intent").eq("user_id", USER_ID);
  return (data ?? []) as Array<{ credits_consumed: number; intent: string }>;
}
async function reservations(workflowId?: string) {
  let q = db.from("pro_budget_reservations").select("workflow_id, reserved_credits, settled_credits, status");
  if (workflowId) q = q.eq("workflow_id", workflowId);
  const { data } = await q;
  return (data ?? []) as Array<{ workflow_id: string; reserved_credits: number; settled_credits: number | null; status: string }>;
}
async function providerRunCredits(workflowId: string): Promise<number> {
  const { data } = await db.from("pro_provider_runs").select("cost_credits").eq("workflow_id", workflowId);
  return ((data ?? []) as Array<{ cost_credits: number | null }>).reduce((s, r) => s + (r.cost_credits ?? 0), 0);
}
async function workflowRow(workflowId: string) {
  const { data } = await db.from("pro_workflows").select("status, actual_cost_credits, reserved_credits").eq("id", workflowId).maybeSingle();
  return data as { status: string; actual_cost_credits: number | null; reserved_credits: number } | null;
}

async function newWorkflow(budget?: Record<string, number>): Promise<string> {
  const res = await createProWorkflow(fastify, user(), OBJECTIVE);
  if (!res.workflowId) throw new Error(`createProWorkflow returned no workflowId (complexity=${res.complexity})`);
  if (budget) await db.from("pro_workflows").update(budget).eq("id", res.workflowId);
  return res.workflowId;
}
async function drive(workflowId: string, registry: AIProvider[], cap = 30) {
  let last;
  for (let i = 0; i < cap; i++) {
    last = await executeWorkflowStep(fastify, user(), workflowId, registry);
    if (["COMPLETED", "FAILED", "CANCELLED", "WAITING_FOR_USER"].includes(last.workflowStatus)) break;
  }
  return last!;
}

// ---------------------------------------------------------------------------
async function main() {
  // pro_workflows.user_id FKs to auth.users — so the synthetic user must
  // be a real auth user. createUser fires the on_auth_user_created trigger
  // which mirrors a row into public.users; we then flip that row to 'pro'.
  const email = `pro-atomicity-probe-${randomUUID().slice(0, 8)}@splex-benchmark.invalid`;
  const created = await db.auth.admin.createUser({ email, email_confirm: true });
  if (created.error || !created.data.user) throw new Error(`createUser failed: ${created.error?.message}`);
  USER_ID = created.data.user.id;
  const flip = await db.from("users").update({ plan_tier: "pro" }).eq("id", USER_ID).select("id, plan_tier").maybeSingle();
  if (flip.error || (flip.data as { plan_tier: string } | null)?.plan_tier !== "pro") {
    throw new Error(`could not set synthetic user to plan_tier='pro': ${flip.error?.message ?? "no public.users row mirrored"}`);
  }
  console.log(`synthetic pro user: ${USER_ID} (${email})\n`);

  const monthlyStart = await monthlyUsed();
  check("synthetic user starts with a clean monthly credits counter", monthlyStart === 0, `used=${monthlyStart}`);
  check("synthetic user starts with NO daily-pool rows", (await dailyRowCount()) === 0);

  try {
    // === S1 — N concurrent first-steps on ONE fresh workflow =================
    console.log("\n== S1: 25 concurrent executeWorkflowStep on one fresh workflow ==");
    {
      const wf = await newWorkflow({ max_provider_calls: 4, max_collaboration_depth: 12 });
      const before = await monthlyUsed();
      const outcomes = await Promise.all(
        Array.from({ length: 25 }, () => executeWorkflowStep(fastify, user(), wf, okRegistry())),
      );
      const rs = await reservations(wf);
      check("exactly ONE pro_budget_reservations row after 25 concurrent first-steps", rs.length === 1, `rows=${rs.length}`);
      check("that reservation is the ceiling (25000), drawn from monthly not daily", rs[0]?.reserved_credits === 25_000, `reserved=${rs[0]?.reserved_credits}`);
      check("no daily-pool row was created by the reservation", (await dailyRowCount()) === 0);
      check("monthly counter NOT moved by the reservation itself (charge is at finalize)", (await monthlyUsed()) === before, `delta=${(await monthlyUsed()) - before}`);
      check("every one of the 25 callers returned a coherent result (none stranded/threw)", outcomes.length === 25 && outcomes.every((o) => o.workflowId === wf));

      const last = await drive(wf, okRegistry());
      const recorded = await providerRunCredits(wf);
      const wfRow = await workflowRow(wf);
      const rs2 = await reservations(wf);
      const led = (await ledgerRows()).filter((l) => l.intent === "pro_workflow");
      check("workflow reached a terminal state", ["COMPLETED", "FAILED"].includes(last.workflowStatus), last.workflowStatus);
      check("still exactly ONE reservation row, now settled", rs2.length === 1 && rs2[0].status === "settled", `${rs2.length}/${rs2[0]?.status}`);
      check("settled_credits == sum(pro_provider_runs.cost_credits)", rs2[0]?.settled_credits === recorded, `settled=${rs2[0]?.settled_credits} recorded=${recorded}`);
      check("pro_workflows.actual_cost_credits == recorded spend", wfRow?.actual_cost_credits === recorded, `actual=${wfRow?.actual_cost_credits} recorded=${recorded}`);
      check("exactly ONE monthly-pool ledger row for this workflow's settle", led.length === 1, `ledger rows=${led.length}`);
      check("ledger amount == recorded spend (no drift, no shadow price)", led[0]?.credits_consumed === recorded, `ledger=${led[0]?.credits_consumed} recorded=${recorded}`);
      check("STILL no daily-pool contamination after a full run", (await dailyRowCount()) === 0);
    }

    const afterS1 = await monthlyUsed();

    // === S2 — N concurrent cancels ==========================================
    console.log("\n== S2: 12 concurrent cancelProWorkflow on one RUNNING workflow ==");
    {
      const wf = await newWorkflow({ max_provider_calls: 6, max_collaboration_depth: 12 });
      await executeWorkflowStep(fastify, user(), wf, okRegistry()); // -> RUNNING + reserve
      const before = await monthlyUsed();
      const outcomes = await Promise.all(Array.from({ length: 12 }, () => cancelProWorkflow(fastify, user(), wf)));
      const cancelled = outcomes.filter((o) => o.message === "Workflow cancelled.");
      const rs = await reservations(wf);
      const recorded = await providerRunCredits(wf);
      const led = (await ledgerRows()).filter((l) => l.intent === "pro_workflow");
      check("exactly ONE of 12 concurrent cancels reports 'Workflow cancelled.'", cancelled.length === 1, `won=${cancelled.length}`);
      check("workflow row is CANCELLED", (await workflowRow(wf))?.status === "CANCELLED");
      check("exactly ONE reservation row, settled once", rs.length === 1 && rs[0].status === "settled", `${rs.length}/${rs[0]?.status}`);
      check("monthly delta for this workflow == its recorded spend (no double consume)", (await monthlyUsed()) - before === recorded, `delta=${(await monthlyUsed()) - before} recorded=${recorded}`);
      check("at most ONE new ledger row from the 12 concurrent cancels", led.length <= 2, `total pro_workflow ledger rows=${led.length}`);
      check("no daily-pool contamination", (await dailyRowCount()) === 0);
    }

    // === S3 — cancel racing a step, repeated ================================
    console.log("\n== S3: 8 trials of Promise.all([executeWorkflowStep, cancelProWorkflow]) ==");
    {
      let drift = 0;
      let stranded = 0;
      for (let t = 0; t < 8; t++) {
        const wf = await newWorkflow({ max_provider_calls: 6, max_collaboration_depth: 12 });
        const before = await monthlyUsed();
        const reg = [scripted("openai", { kind: "ok", costUsd: 0.004, delayMs: t })];
        await Promise.all([
          executeWorkflowStep(fastify, user(), wf, reg),
          cancelProWorkflow(fastify, user(), wf),
        ]);
        // let any in-flight settle land
        await new Promise((r) => setTimeout(r, 40));
        const wfRow = await workflowRow(wf);
        const recorded = await providerRunCredits(wf);
        const delta = (await monthlyUsed()) - before;
        const rs = await reservations(wf);
        const terminal = ["CANCELLED", "COMPLETED", "FAILED"].includes(wfRow?.status ?? "");
        const settledOrNone = rs.length === 0 || (rs.length === 1 && rs[0].status === "settled");
        if (delta > recorded) drift++;
        if (!settledOrNone || !terminal) stranded++;
        console.log(`   trial ${t}: status=${wfRow?.status} recorded=${recorded} monthlyΔ=${delta} reservation=${rs[0]?.status ?? "none"}`);
      }
      check("every trial ended terminal with a settled/absent reservation (no stranded reservation)", stranded === 0, `stranded=${stranded}`);
      check("no trial charged MORE than it recorded (no over-consume under the race)", drift === 0, `over-charged trials=${drift}`);
      check("no daily-pool contamination across all 8 trials", (await dailyRowCount()) === 0);
    }

    // === S4 — accounting drift over a concurrent batch =====================
    console.log("\n== S4: 5 workflows driven to completion concurrently, one user ==");
    {
      const before = await monthlyUsed();
      const wfs = await Promise.all(Array.from({ length: 5 }, () => newWorkflow({ max_provider_calls: 20, max_collaboration_depth: 12 })));
      await Promise.all(wfs.map((wf) => drive(wf, okRegistry())));
      let sumActual = 0;
      let sumRuns = 0;
      for (const wf of wfs) {
        const row = await workflowRow(wf);
        sumActual += row?.actual_cost_credits ?? 0;
        sumRuns += await providerRunCredits(wf);
        check(`  workflow ${wf.slice(0, 8)} terminal + settled`, ["COMPLETED", "FAILED"].includes(row?.status ?? "") && (await reservations(wf))[0]?.status === "settled", row?.status);
      }
      const monthlyDelta = (await monthlyUsed()) - before;
      const led = (await ledgerRows()).filter((l) => l.intent === "pro_workflow");
      check("Σ pro_workflows.actual_cost_credits == Σ pro_provider_runs.cost_credits", sumActual === sumRuns, `actual=${sumActual} runs=${sumRuns}`);
      check("monthly-pool delta over the batch == Σ recorded spend (zero drift)", monthlyDelta === sumRuns, `monthlyΔ=${monthlyDelta} Σruns=${sumRuns}`);
      // S1 (1) + S2's cancelled-but-spent workflow (1) + these 5 = 7.
      check("one ledger row per workflow that actually spent (S1 + S2 + these 5)", led.length === wfs.length + 2, `pro_workflow ledger rows=${led.length}, expected ${wfs.length + 2}`);
      check("STILL no daily-pool rows for this user after the whole probe", (await dailyRowCount()) === 0);
    }

    // === Final reconciliation =============================================
    const totalRecorded = await (async () => {
      const { data } = await db.from("pro_provider_runs").select("cost_credits, workflow_id");
      const { data: wfIds } = await db.from("pro_workflows").select("id").eq("user_id", USER_ID);
      const ids = new Set((wfIds ?? []).map((w: { id: string }) => w.id));
      return ((data ?? []) as Array<{ cost_credits: number | null; workflow_id: string }>)
        .filter((r) => ids.has(r.workflow_id))
        .reduce((s, r) => s + (r.cost_credits ?? 0), 0);
    })();
    const finalMonthly = await monthlyUsed();
    console.log("\n== FINAL RECONCILIATION ==");
    check("final monthly credits used == total recorded provider spend across ALL probe workflows",
      finalMonthly - monthlyStart === totalRecorded, `monthly=${finalMonthly - monthlyStart} recorded=${totalRecorded}`);
    check("final daily-pool rows for the synthetic user: still ZERO", (await dailyRowCount()) === 0);
  } finally {
    // ---- teardown: remove everything this probe created ----
    if (USER_ID) {
      const { data: wfIds } = await db.from("pro_workflows").select("id").eq("user_id", USER_ID);
      const ids = (wfIds ?? []).map((w: { id: string }) => w.id);
      if (ids.length) await db.from("pro_workflows").delete().in("id", ids); // cascades pro_tasks/reservations/runs/artifacts/...
      await db.from("usage_counters").delete().eq("user_id", USER_ID);
      await db.from("credit_usage_logs").delete().eq("user_id", USER_ID);
      const del = await db.auth.admin.deleteUser(USER_ID); // cascades auth.users -> public.users
      if (del.error) await db.from("users").delete().eq("id", USER_ID);
      const { data: leftWf } = await db.from("pro_workflows").select("id").eq("user_id", USER_ID);
      const { data: leftUser } = await db.from("users").select("id").eq("id", USER_ID).maybeSingle();
      const { data: leftAuth } = await db.auth.admin.getUserById(USER_ID);
      console.log(`\nteardown: workflows left=${(leftWf ?? []).length}, public.users row left=${leftUser ? "YES (!)" : "no"}, auth user left=${leftAuth.user ? "YES (!)" : "no"}`);
    }
  }

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) {
    console.log("FAILURES: " + failures.join(" | "));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nPROBE ERROR:", err);
  process.exitCode = 1;
});
