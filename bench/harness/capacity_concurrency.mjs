/**
 * Live concurrency proof for admit_openrouter_free_request (migration 0054).
 *
 * A JS-side fake cannot prove this function's actual safety property — that
 * property IS Postgres's row-level locking, and the only way to prove it
 * holds is to fire real concurrent calls at the real deployed function and
 * check what actually comes back. This is the same standard already applied
 * to free/paid isolation this session (isolation_suite.mjs, up to 30,414
 * real invocations) — a security/economics-relevant atomicity claim is
 * measured, not asserted.
 *
 * Uses a dedicated, clearly-fake model id (never a real registry entry) and
 * synthetic user ids, so this can never collide with real routing decisions
 * or pollute a real user's daily counters. Cleans up every row it wrote.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// usage_counters.user_id carries a real FK to public.users -> auth.users
// (confirmed live before writing this script), so a fabricated random UUID
// is rejected outright — correctly; this is exactly the kind of integrity
// guarantee that makes "user id manipulation" structurally impossible at
// the database layer, not just policy. Every "user" position below reuses
// the ALREADY-PROVISIONED, isolated benchmark account (bench/harness/
// provision.py) rather than inventing identities. Each sub-test still uses
// its own distinct synthetic MODEL id, so reusing one real user id across
// sub-tests causes no cross-contamination between them.
const BENCH_USER_ID = process.env.SPLEX_BENCH_USER_ID;
if (!BENCH_USER_ID) {
  console.error("SPLEX_BENCH_USER_ID is required — run provision.py first and pass its user_id.");
  process.exit(2);
}

function loadEnv(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = loadEnv(process.env.SPLEX_ENV_FILE ?? `${process.env.HOME}/Desktop/Splex/apps/backend/.env`);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const TEST_MODEL = "concurrency-probe/synthetic:free"; // never a real registry row
const results = { pass: 0, fail: 0, details: [] };

function check(label, cond, detail = "") {
  results[cond ? "pass" : "fail"]++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  [${detail}]` : ""}`);
  if (!cond) results.details.push(label);
}

async function admit(userId, modelId, perUserCap, modelCap) {
  const { data, error } = await db.rpc("admit_openrouter_free_request", {
    p_user_id: userId, p_model_id: modelId,
    p_per_user_daily_cap: perUserCap, p_model_daily_cap: modelCap,
  });
  if (error) throw new Error(`RPC error: ${error.message}`);
  return data;
}

async function cleanup(userIds, modelIds) {
  for (const uid of userIds) {
    await db.from("usage_counters").delete().eq("user_id", uid).eq("counter_type", "openrouter_free_requests");
  }
  for (const mid of modelIds) {
    await db.from("provider_free_model_capacity").delete().eq("model_id", mid);
  }
}

// The per-user counter is keyed by (user_id, counter_type, period_start)
// ONLY — not by model. Every sub-test below reuses the same real
// BENCH_USER_ID (see the FK note above), so without an explicit reset
// between sub-tests, an earlier sub-test's admits would silently carry
// into a later one's fair-share assertion and produce a wrong result that
// LOOKS like a bug in the RPC but is actually just leftover counter state
// from this script's own earlier sub-test. Reset before every sub-test
// that makes a claim about the exact per-user count.
async function resetUserCounter() {
  await db.from("usage_counters").delete()
    .eq("user_id", BENCH_USER_ID).eq("counter_type", "openrouter_free_requests");
}

async function main() {
  const allUserIds = new Set();
  const allModelIds = new Set();

  // ---- 1. Sequential correctness: exactly N admits, then denials ----
  console.log("== sequential correctness ==");
  {
    await resetUserCounter();
    const user = BENCH_USER_ID;
    const model = `${TEST_MODEL}-seq`;
    allUserIds.add(user); allModelIds.add(model);
    const cap = 5;
    const outcomes = [];
    for (let i = 0; i < cap + 3; i++) outcomes.push(await admit(user, model, 100, cap));
    check("exactly 5 'ok'", outcomes.filter((o) => o === "ok").length === 5, JSON.stringify(outcomes));
    check("remaining 3 are provider_capacity_exhausted",
      outcomes.slice(5).every((o) => o === "provider_capacity_exhausted"), JSON.stringify(outcomes.slice(5)));
  }

  // ---- 2. Sequential fair-share correctness ----
  console.log("\n== sequential fair-share correctness ==");
  {
    await resetUserCounter();
    const user = BENCH_USER_ID;
    const model = `${TEST_MODEL}-fair`;
    allUserIds.add(user); allModelIds.add(model);
    const cap = 3;
    const outcomes = [];
    for (let i = 0; i < cap + 2; i++) outcomes.push(await admit(user, model, cap, 1000));
    check("exactly 3 'ok'", outcomes.filter((o) => o === "ok").length === 3, JSON.stringify(outcomes));
    check("remaining 2 are fair_share_exceeded",
      outcomes.slice(3).every((o) => o === "fair_share_exceeded"), JSON.stringify(outcomes.slice(3)));
  }

  // ---- 3. REAL CONCURRENCY: N parallel callers, tiny shared cap ----
  console.log("\n== concurrency: 50 parallel callers, model cap = 10 ==");
  {
    const model = `${TEST_MODEL}-concurrent`;
    allModelIds.add(model);
    const callers = Array.from({ length: 50 }, () => BENCH_USER_ID);
    const outcomes = await Promise.all(callers.map((u) => admit(u, model, 100, 10)));
    const oks = outcomes.filter((o) => o === "ok").length;
    check("exactly 10 admitted despite 50 simultaneous callers (no over-admission)", oks === 10, `oks=${oks}`);
    check("the other 40 were denied for the right reason (provider_capacity_exhausted)",
      outcomes.filter((o) => o === "provider_capacity_exhausted").length === 40,
      JSON.stringify(outcomes.reduce((m, o) => ((m[o] = (m[o] || 0) + 1), m), {})));
  }

  // ---- 4. Concurrency on the PER-USER side: one user, many parallel attempts ----
  console.log("\n== concurrency: one user, 50 parallel attempts, fair-share cap = 10 ==");
  {
    await resetUserCounter();
    const user = BENCH_USER_ID;
    const model = `${TEST_MODEL}-user-concurrent`;
    allUserIds.add(user); allModelIds.add(model);
    const outcomes = await Promise.all(Array.from({ length: 50 }, () => admit(user, model, 10, 1000)));
    const oks = outcomes.filter((o) => o === "ok").length;
    check("exactly 10 admitted for one user despite 50 simultaneous attempts", oks === 10, `oks=${oks}`);
  }

  // ---- 5. Independence: exhausting one model does not affect a different model ----
  console.log("\n== independence: exhausting model A leaves model B untouched (same user) ==");
  {
    const userA = BENCH_USER_ID;
    const modelA = `${TEST_MODEL}-indep-a`, modelB = `${TEST_MODEL}-indep-b`;
    [modelA, modelB].forEach((m) => allModelIds.add(m));
    await admit(userA, modelA, 1000, 1); // exhausts modelA's tiny cap
    const stillExhausted = await admit(userA, modelA, 1000, 1);
    check("modelA is now exhausted", stillExhausted === "provider_capacity_exhausted");
    const otherModel = await admit(userA, modelB, 1000, 1);
    check("the same user can still use a DIFFERENT model — exhaustion is per-model, not account-wide",
      otherModel === "ok");
  }

  // ---- 6. mark_provider_model_exhausted immediately blocks further admits ----
  console.log("\n== reactive exhaustion: mark_provider_model_exhausted takes effect immediately ==");
  {
    const user = BENCH_USER_ID;
    const model = `${TEST_MODEL}-reactive`;
    allUserIds.add(user); allModelIds.add(model);
    const before = await admit(user, model, 100, 50); // plenty of room
    check("admitted before marking", before === "ok");
    const { error } = await db.rpc("mark_provider_model_exhausted", { p_model_id: model });
    check("mark_provider_model_exhausted succeeded", !error, error?.message);
    const after = await admit(user, model, 100, 50); // same generous cap — should now be denied anyway
    check("denied immediately after marking, even though the configured cap was not otherwise reached",
      after === "provider_capacity_exhausted");
  }

  console.log(`\ncleaning up ${allUserIds.size} synthetic user counters and ${allModelIds.size} synthetic model counters...`);
  await cleanup(allUserIds, allModelIds);

  console.log(`\n${results.pass}/${results.pass + results.fail} checks passed`);
  if (results.fail > 0) {
    console.log("FAILURES:", results.details);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
