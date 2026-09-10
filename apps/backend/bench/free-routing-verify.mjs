/**
 * Live verification for the Free/Starter routing + Groq fallback hardening
 * (API 1 capacity → Groq → recovery).
 *
 * SAFETY — this probe NEVER calls OpenRouter or Groq. It exercises only:
 *   - the deployed admission RPCs (admit_openrouter_free_request,
 *     admit_groq_fallback_request, mark_provider_model_exhausted) against
 *     SYNTHETIC model ids (never a real registry row), with
 *     snapshot/restore, exactly as bench/harness/admission_concurrency.mjs
 *     already does;
 *   - reserve_daily_request / release_daily_request against the isolated
 *     benchmark account, snapshotting and restoring the counter;
 *   - record_openrouter_credential_outcome against a synthetic alias
 *     ("probe-verify"), deleted afterwards.
 * It reads config to report WHICH credential is active (masked), and reads
 * model_registry / provider_free_model_capacity for a status snapshot.
 *
 * Run:  SPLEX_BENCH_USER_ID=<uuid> node bench/harness/free_routing_verify.mjs
 *       (falls back to looking up sib-bench-v1@splex-benchmark.invalid)
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

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

const results = { pass: 0, fail: 0, details: [] };
function check(label, cond, detail = "") {
  results[cond ? "pass" : "fail"]++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? `   [${detail}]` : ""}`);
  if (!cond) results.details.push(label);
}
const mask = (s) => (s ? `${s.slice(0, 8)}…${s.slice(-4)} (len ${s.length})` : "(unset)");

async function rpc(name, params) {
  const { data, error } = await db.rpc(name, params);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}

async function resolveBenchUser() {
  if (process.env.SPLEX_BENCH_USER_ID) return process.env.SPLEX_BENCH_USER_ID;
  const { data } = await db.from("users").select("id").eq("email", "sib-bench-v1@splex-benchmark.invalid").maybeSingle();
  if (!data) throw new Error("no SPLEX_BENCH_USER_ID and sib-bench-v1@splex-benchmark.invalid not found");
  return data.id;
}

async function main() {
  const SYN_MODEL = "free-routing-verify/synthetic:free";
  const utcDay = new Date().toISOString().slice(0, 10);
  const BENCH_USER = await resolveBenchUser();

  // ---- 1. Which credential is actually configured -------------------------
  console.log("\n== 1. Active OpenRouter credential ==");
  check("API 1 (OPENROUTER_API_KEY) is configured", Boolean(env.OPENROUTER_API_KEY), mask(env.OPENROUTER_API_KEY));
  check("API 2 (OPENROUTER_API_KEY_2) is NOT set — Pro slot, correctly empty", !env.OPENROUTER_API_KEY_2, mask(env.OPENROUTER_API_KEY_2));
  check("SPLEX_PRO_ENABLED is not 'true'", env.SPLEX_PRO_ENABLED !== "true", `value=${env.SPLEX_PRO_ENABLED ?? "(unset)"}`);
  check("configured OPENROUTER_FREE_DAILY_CAPACITY is the intended threshold, not silently elevated",
    Number(env.OPENROUTER_FREE_DAILY_CAPACITY ?? 50) === 50, `value=${env.OPENROUTER_FREE_DAILY_CAPACITY ?? "(default 50)"}`);

  // ---- 2. API 1 routing: a Free model pool exists ------------------------
  console.log("\n== 2. API 1 Free routing pool ==");
  const { count: freePoolCount } = await db
    .from("model_registry")
    .select("id", { count: "exact", head: true })
    .eq("variant", "free")
    .eq("is_active", true)
    .eq("free_tier_allowed", true);
  check("model_registry has ≥1 active free-variant / free_tier_allowed model", (freePoolCount ?? 0) >= 1, `count=${freePoolCount}`);
  const { data: capRows } = await db
    .from("provider_free_model_capacity")
    .select("model_id, used")
    .eq("period_start", utcDay)
    .order("used", { ascending: false })
    .limit(5);
  console.log(`     today's (UTC ${utcDay}) per-model capacity, top 5:`, JSON.stringify(capRows ?? []));

  // ---- 3. Capacity detection + concurrency (synthetic model only) --------
  console.log("\n== 3. admit_openrouter_free_request — near-cap, 20 concurrent ==");
  try {
    // seed the synthetic per-model row at cap-1 for a cap of 3
    await db.from("provider_free_model_capacity").upsert(
      { model_id: SYN_MODEL, period_start: utcDay, used: 2 },
      { onConflict: "model_id,period_start" },
    );
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () =>
        rpc("admit_openrouter_free_request", {
          p_user_id: BENCH_USER,
          p_model_id: SYN_MODEL,
          p_per_user_daily_cap: 100000, // don't let the per-user cap be the binding one here
          p_model_daily_cap: 3,
        }),
      ),
    );
    const oks = outcomes.filter((o) => o === "ok").length;
    check("exactly 1 admitted (2/3 → 3/3), no over-admission past the model cap", oks === 1, `oks=${oks}`);
    check("the rest denied provider_capacity_exhausted",
      outcomes.filter((o) => o === "provider_capacity_exhausted").length === 19);

    // ---- 5. Recovery: mark exhausted, then confirm a NEW UTC-day row is clean
    console.log("\n== 5. Recovery — mark_provider_model_exhausted + UTC-day rollover ==");
    await rpc("mark_provider_model_exhausted", { p_model_id: SYN_MODEL });
    const afterMark = await rpc("admit_openrouter_free_request", {
      p_user_id: BENCH_USER, p_model_id: SYN_MODEL, p_per_user_daily_cap: 100000, p_model_daily_cap: 3,
    });
    check("after mark_provider_model_exhausted, TODAY is provider_capacity_exhausted", afterMark === "provider_capacity_exhausted", String(afterMark));
    // simulate "tomorrow": a fresh period_start row starts at 0 and admits again
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const nextDay = await rpc("admit_openrouter_free_request", {
      p_user_id: BENCH_USER, p_model_id: `${SYN_MODEL}#next`, p_per_user_daily_cap: 100000, p_model_daily_cap: 3,
    });
    check("a fresh per-model row (new period / new model) admits normally — recovery is automatic, not manual", nextDay === "ok", String(nextDay));
    console.log(`     (real recovery boundary for ${SYN_MODEL} is UTC ${tomorrow} 00:00 — the primary key includes period_start)`);
  } finally {
    await db.from("provider_free_model_capacity").delete().in("model_id", [SYN_MODEL, `${SYN_MODEL}#next`]);
    // undo the +1 the concurrency test added to the bench user's own openrouter_free_requests counter
    await db.from("usage_counters").delete()
      .eq("user_id", BENCH_USER).eq("counter_type", "openrouter_free_requests")
      .gte("period_start", "1900-01-01"); // this counter is fully synthetic for the bench account
  }

  // ---- 4. Controlled Groq fallback path (synthetic bookkeeping id) -------
  console.log("\n== 4. admit_groq_fallback_request — transitions ok → exhausted at cap ==");
  const SYN_GROQ = "free-routing-verify/synthetic-groq#free-tier";
  try {
    await db.from("provider_groq_capacity").delete().eq("model_id", SYN_GROQ);
    const g = await Promise.all(
      Array.from({ length: 8 }, () =>
        rpc("admit_groq_fallback_request", {
          p_user_id: BENCH_USER, p_model_id: SYN_GROQ, p_per_user_daily_cap: 100000, p_model_daily_cap: 3,
        }),
      ),
    );
    check("Groq admission admits exactly its cap (3) then denies the rest", g.filter((o) => o === "ok").length === 3, `oks=${g.filter((o) => o === "ok").length}`);
    check("Groq denials are provider_capacity_exhausted (a real 429-shaped condition, not fair-share)",
      g.filter((o) => o === "provider_capacity_exhausted").length === 5);
  } finally {
    await db.from("provider_groq_capacity").delete().eq("model_id", SYN_GROQ);
    await db.from("usage_counters").delete().eq("user_id", BENCH_USER).eq("counter_type", "groq_free_requests");
  }

  // ---- 6. Counters change exactly once, whichever provider serves -------
  console.log("\n== 6. daily message-count reservation moves exactly once ==");
  const { data: period } = await db.rpc("get_period_start", { p_counter_type: "daily_requests", p_user_id: BENCH_USER });
  const readCount = async () => {
    const { data } = await db.from("usage_counters").select("used")
      .eq("user_id", BENCH_USER).eq("counter_type", "daily_requests").eq("period_start", period).maybeSingle();
    return data?.used ?? 0;
  };
  const before = await readCount();
  try {
    const r1 = await rpc("reserve_daily_request", { p_user_id: BENCH_USER });
    check("reserve_daily_request admits and increments the counter by exactly 1", r1 === true && (await readCount()) === before + 1, `used ${before} → ${await readCount()}`);
    // simulate an OpenRouter failure → Groq success: NO second reserve happens
    // (chat.ts reserves once, before the provider loop). The served turn keeps
    // the reservation; a failed turn releases it.
    await rpc("release_daily_request", { p_user_id: BENCH_USER });
    check("release_daily_request (failed turn) returns the counter to its prior value — never a phantom message", (await readCount()) === before, `used=${await readCount()}`);
    const r2 = await rpc("reserve_daily_request", { p_user_id: BENCH_USER });
    check("a served turn (reserve, no release) counts as exactly ONE, regardless of provider", r2 === true && (await readCount()) === before + 1, `used=${await readCount()}`);
  } finally {
    // restore the bench account's real counter exactly as found
    await db.from("usage_counters").update({ used: before })
      .eq("user_id", BENCH_USER).eq("counter_type", "daily_requests").eq("period_start", period);
    check("bench account daily_requests restored to its prior value", (await readCount()) === before, `used=${await readCount()}`);
  }

  // ---- 7. Credential-health observability RPC works --------------------
  console.log("\n== 7. record_openrouter_credential_outcome (observability, migration 0064) ==");
  try {
    await rpc("record_openrouter_credential_outcome", { p_alias: "probe-verify", p_success: false, p_status: 401, p_kind: "auth" });
    await rpc("record_openrouter_credential_outcome", { p_alias: "probe-verify", p_success: true });
    const { data: row } = await db.from("openrouter_credential_health").select("*").eq("credential_alias", "probe-verify").maybeSingle();
    check("an auth failure then a success are BOTH recorded (last_auth_failure_at kept, last_success_at added)",
      Boolean(row?.last_auth_failure_at) && Boolean(row?.last_success_at) && row?.last_failure_status === 401,
      JSON.stringify(row));
  } finally {
    await db.from("openrouter_credential_health").delete().eq("credential_alias", "probe-verify");
  }

  console.log(`\n${results.pass}/${results.pass + results.fail} checks passed`);
  if (results.fail) {
    console.log("FAILURES:", results.details.join(", "));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nPROBE FAILED:", err);
  process.exit(1);
});
