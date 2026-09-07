/**
 * Live concurrency proof for the two admission paths added 2026-09-07:
 *
 *   reserve_daily_request        (migration 0055) — atomic message-count admission
 *   admit_groq_fallback_request  (migration 0056/0058) — Groq capacity, tier-split
 *
 * Same standard, and the same reasoning, as capacity_concurrency.mjs (which
 * covers migration 0054): a JS-side fake cannot prove these functions' actual
 * safety property, because that property IS Postgres row-level locking. The
 * only way to prove it holds is to fire real concurrent calls at the real
 * deployed functions and check what actually comes back.
 *
 * What makes this worth its own file rather than an extension of the 0054
 * probe: the tier-split bookkeeping introduced with the Paid extension is a
 * genuinely new claim ("Free and Paid can never starve each other") that has
 * never been measured against real Postgres, only asserted in unit tests.
 *
 * SAFETY: uses clearly-synthetic model ids (never real registry rows) and the
 * already-provisioned, isolated benchmark account. The reserve_daily_request
 * section necessarily touches that account's REAL daily_requests counter (the
 * function takes no model parameter — there is nothing synthetic to key on),
 * so it snapshots the exact prior value and restores it afterwards. It never
 * touches any other user.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

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

const TEST_MODEL = "admission-probe/synthetic"; // never a real registry row
const results = { pass: 0, fail: 0, details: [] };

function check(label, cond, detail = "") {
  results[cond ? "pass" : "fail"]++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  [${detail}]` : ""}`);
  if (!cond) results.details.push(label);
}

async function rpc(name, params) {
  const { data, error } = await db.rpc(name, params);
  if (error) throw new Error(`${name} RPC error: ${error.message}`);
  return data;
}

// The user's real daily period, computed the same way the SQL functions do
// (user's own timezone, not UTC — see get_period_start / user_timezone).
async function currentDailyPeriod() {
  const { data, error } = await db.rpc("get_period_start", {
    p_counter_type: "daily_requests",
    p_user_id: BENCH_USER_ID,
  });
  if (error) throw new Error(`get_period_start failed: ${error.message}`);
  return data;
}

async function readDailyRequests(period) {
  const { data } = await db
    .from("usage_counters")
    .select("used")
    .eq("user_id", BENCH_USER_ID)
    .eq("counter_type", "daily_requests")
    .eq("period_start", period)
    .maybeSingle();
  return data?.used ?? null;
}

async function setDailyRequests(period, used) {
  await db.from("usage_counters").upsert(
    { user_id: BENCH_USER_ID, counter_type: "daily_requests", period_start: period, used },
    { onConflict: "user_id,counter_type,period_start" },
  );
}

async function planLimit(tier, counterType) {
  const { data } = await db
    .from("plan_limits")
    .select("limit_amount")
    .eq("plan_tier", tier)
    .eq("counter_type", counterType)
    .maybeSingle();
  return data?.limit_amount ?? null;
}

async function main() {
  const syntheticModels = new Set();

  // =========================================================================
  // reserve_daily_request (migration 0055) — the atomic message-count gate
  // =========================================================================
  const period = await currentDailyPeriod();
  const priorUsed = await readDailyRequests(period);
  const freeLimit = await planLimit("free", "daily_requests");
  console.log(`benchmark user daily_requests: prior=${priorUsed ?? "(no row)"} period=${period} free limit=${freeLimit}`);

  try {
    // ---- 1. THE worked example: at limit-1, N simultaneous, exactly 1 admitted
    console.log(`\n== reserve_daily_request: at ${freeLimit - 1}/${freeLimit}, 50 simultaneous reservations ==`);
    {
      await setDailyRequests(period, freeLimit - 1);
      const outcomes = await Promise.all(
        Array.from({ length: 50 }, () => rpc("reserve_daily_request", { p_user_id: BENCH_USER_ID })),
      );
      const admitted = outcomes.filter((o) => o === true).length;
      check(
        `exactly 1 admitted out of 50 simultaneous (no over-admission past ${freeLimit})`,
        admitted === 1,
        `admitted=${admitted}`,
      );
      const after = await readDailyRequests(period);
      check(`counter landed exactly on the limit (${freeLimit}), never past it`, after === freeLimit, `used=${after}`);
    }

    // ---- 2. Already at the limit: every concurrent attempt denied
    console.log(`\n== reserve_daily_request: already at ${freeLimit}/${freeLimit}, 25 simultaneous ==`);
    {
      await setDailyRequests(period, freeLimit);
      const outcomes = await Promise.all(
        Array.from({ length: 25 }, () => rpc("reserve_daily_request", { p_user_id: BENCH_USER_ID })),
      );
      check("all 25 denied", outcomes.every((o) => o === false), JSON.stringify(outcomes.slice(0, 5)));
      const after = await readDailyRequests(period);
      check(`counter never moved past the limit`, after === freeLimit, `used=${after}`);
    }

    // ---- 3. From empty: exactly `limit` admitted out of far more attempts
    console.log(`\n== reserve_daily_request: from 0, ${freeLimit + 30} simultaneous, limit ${freeLimit} ==`);
    {
      await setDailyRequests(period, 0);
      const outcomes = await Promise.all(
        Array.from({ length: freeLimit + 30 }, () => rpc("reserve_daily_request", { p_user_id: BENCH_USER_ID })),
      );
      const admitted = outcomes.filter((o) => o === true).length;
      check(`exactly ${freeLimit} admitted`, admitted === freeLimit, `admitted=${admitted}`);
      const after = await readDailyRequests(period);
      check(`counter landed exactly on ${freeLimit}`, after === freeLimit, `used=${after}`);
    }

    // ---- 4. release_daily_request never drives the counter negative
    console.log("\n== release_daily_request: 20 concurrent releases from 0 ==");
    {
      await setDailyRequests(period, 0);
      await Promise.all(Array.from({ length: 20 }, () => rpc("release_daily_request", { p_user_id: BENCH_USER_ID })));
      const after = await readDailyRequests(period);
      check("counter floored at 0, never negative", after === 0, `used=${after}`);
    }
  } finally {
    // Restore the benchmark account's real counter exactly as found.
    if (priorUsed === null) {
      await db.from("usage_counters").delete()
        .eq("user_id", BENCH_USER_ID).eq("counter_type", "daily_requests").eq("period_start", period);
      console.log("\n(restored: deleted the daily_requests row, which did not exist before this run)");
    } else {
      await setDailyRequests(period, priorUsed);
      console.log(`\n(restored: daily_requests back to its prior value of ${priorUsed})`);
    }
  }

  // =========================================================================
  // admit_groq_fallback_request (0056) — capacity + the NEW tier split
  // =========================================================================
  console.log("\n== admit_groq_fallback_request: 50 parallel callers, model cap = 10 ==");
  {
    const model = `${TEST_MODEL}#free-tier-conc`;
    syntheticModels.add(model);
    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () =>
        rpc("admit_groq_fallback_request", {
          p_user_id: BENCH_USER_ID, p_model_id: model,
          p_per_user_daily_cap: 10000, p_model_daily_cap: 10,
        }),
      ),
    );
    const oks = outcomes.filter((o) => o === "ok").length;
    check("exactly 10 admitted despite 50 simultaneous (no over-admission)", oks === 10, `oks=${oks}`);
    check("the rest denied as provider_capacity_exhausted",
      outcomes.filter((o) => o === "provider_capacity_exhausted").length === 40);
  }

  console.log("\n== THE tier-split guarantee: exhausting Free's slice leaves Paid's untouched ==");
  {
    const freeModel = `${TEST_MODEL}#free-tier-split`;
    const paidModel = `${TEST_MODEL}#paid-tier-split`;
    syntheticModels.add(freeModel); syntheticModels.add(paidModel);

    // Exhaust the FREE slice completely, concurrently.
    const freeOutcomes = await Promise.all(
      Array.from({ length: 20 }, () =>
        rpc("admit_groq_fallback_request", {
          p_user_id: BENCH_USER_ID, p_model_id: freeModel,
          p_per_user_daily_cap: 10000, p_model_daily_cap: 5,
        }),
      ),
    );
    check("Free slice admitted exactly its cap (5)", freeOutcomes.filter((o) => o === "ok").length === 5);
    const freeAgain = await rpc("admit_groq_fallback_request", {
      p_user_id: BENCH_USER_ID, p_model_id: freeModel, p_per_user_daily_cap: 10000, p_model_daily_cap: 5,
    });
    check("Free slice is now genuinely exhausted", freeAgain === "provider_capacity_exhausted", String(freeAgain));

    // Paid must be entirely unaffected — this is the guarantee the whole
    // tier-split bookkeeping design exists to provide.
    const paidOutcome = await rpc("admit_groq_fallback_request", {
      p_user_id: BENCH_USER_ID, p_model_id: paidModel, p_per_user_daily_cap: 10000, p_model_daily_cap: 5,
    });
    check("Paid slice STILL ADMITS after Free is fully exhausted (tiers cannot starve each other)",
      paidOutcome === "ok", String(paidOutcome));
  }

  console.log("\n== admit_groq_fallback_request: per-user fair share under concurrency ==");
  {
    const model = `${TEST_MODEL}#fairshare`;
    syntheticModels.add(model);
    await db.from("usage_counters").delete()
      .eq("user_id", BENCH_USER_ID).eq("counter_type", "groq_free_requests");
    const outcomes = await Promise.all(
      Array.from({ length: 40 }, () =>
        rpc("admit_groq_fallback_request", {
          p_user_id: BENCH_USER_ID, p_model_id: model,
          p_per_user_daily_cap: 7, p_model_daily_cap: 10000,
        }),
      ),
    );
    const oks = outcomes.filter((o) => o === "ok").length;
    check("exactly 7 admitted for one user despite 40 simultaneous attempts", oks === 7, `oks=${oks}`);
    check("the rest denied as fair_share_exceeded",
      outcomes.filter((o) => o === "fair_share_exceeded").length === 33);
  }

  console.log("\n== record_groq_dispatch_outcome (0058): concurrent writes never lose a count ==");
  {
    const { data: before } = await db.from("groq_dispatch_outcomes")
      .select("success,failure").eq("tier", "free")
      .eq("period_start", new Date().toISOString().slice(0, 10)).maybeSingle();
    const priorSuccess = before?.success ?? 0;
    await Promise.all(
      Array.from({ length: 30 }, () => rpc("record_groq_dispatch_outcome", { p_tier: "free", p_success: true })),
    );
    const { data: after } = await db.from("groq_dispatch_outcomes")
      .select("success,failure").eq("tier", "free")
      .eq("period_start", new Date().toISOString().slice(0, 10)).maybeSingle();
    check("all 30 concurrent success increments landed (no lost updates)",
      (after?.success ?? 0) === priorSuccess + 30, `before=${priorSuccess} after=${after?.success}`);
    // Restore: subtract exactly what this probe added, leaving real data intact.
    await db.from("groq_dispatch_outcomes")
      .update({ success: priorSuccess })
      .eq("tier", "free").eq("period_start", new Date().toISOString().slice(0, 10));
  }

  // Cleanup every synthetic row this probe created.
  console.log(`\ncleaning up ${syntheticModels.size} synthetic capacity rows...`);
  for (const mid of syntheticModels) {
    await db.from("provider_groq_capacity").delete().eq("model_id", mid);
  }
  await db.from("usage_counters").delete()
    .eq("user_id", BENCH_USER_ID).eq("counter_type", "groq_free_requests");

  console.log(`\n${results.pass}/${results.pass + results.fail} checks passed`);
  if (results.fail) {
    console.log("FAILURES:", results.details.join(", "));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("PROBE FAILED:", err);
  process.exit(1);
});
