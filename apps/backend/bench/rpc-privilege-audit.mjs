/**
 * Live PostgREST-level regression probe for migration 0065 (lock down
 * consume_credits/reserve_daily_request/release_daily_request EXECUTE
 * grants to service_role only).
 *
 * SAFETY — every mutating call in this probe targets only the isolated
 * benchmark account (sib-bench-v1@splex-benchmark.invalid) or the
 * pre-existing Starter QA account (splex-cf-worker-test-0822@splexqa.test),
 * both created for exactly this purpose, with snapshot/restore around every
 * mutation, matching bench/free-routing-verify.mjs's own discipline. The
 * anon/authenticated denial checks never expect a mutation to happen at
 * all — a permission error at the grant layer, before the function body
 * ever runs, is the PASS condition.
 *
 * The "authenticated" check uses a real Supabase Auth session for the
 * benchmark account, minted via auth.admin.generateLink (magiclink) +
 * verifyOtp — the standard service-role "sign in as" pattern. No email is
 * sent (generateLink only returns the token; it doesn't dispatch mail),
 * and no password is set or changed on the account.
 *
 * Run:  node bench/rpc-privilege-audit.mjs
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

const HOME = process.env.HOME;
const backendEnv = loadEnv(process.env.SPLEX_ENV_FILE ?? `${HOME}/Desktop/Splex/apps/backend/.env`);
let webEnv = {};
try {
  webEnv = loadEnv(`${HOME}/Desktop/Splex/apps/web/.env.local`);
} catch {
  // optional — only needed for the anon key
}
const ANON_KEY = process.env.SPLEX_ANON_KEY ?? webEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!ANON_KEY) throw new Error("no anon key found (SPLEX_ANON_KEY or apps/web/.env.local NEXT_PUBLIC_SUPABASE_ANON_KEY)");

const db = createClient(backendEnv.SUPABASE_URL, backendEnv.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(backendEnv.SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });

const results = { pass: 0, fail: 0, details: [] };
function check(label, cond, detail = "") {
  results[cond ? "pass" : "fail"]++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? `   [${detail}]` : ""}`);
  if (!cond) results.details.push(label);
}

const BENCH_EMAIL = "sib-bench-v1@splex-benchmark.invalid";
const STARTER_EMAIL = "splex-cf-worker-test-0822@splexqa.test";

async function resolveUser(email) {
  const { data } = await db.from("users").select("id, plan_tier").eq("email", email).maybeSingle();
  if (!data) throw new Error(`${email} not found`);
  return data;
}

function isPermissionDenied(error) {
  if (!error) return false;
  return error.code === "42501" || /permission denied/i.test(error.message ?? "");
}

async function readDailyRequestsUsed(userId, period) {
  const { data } = await db
    .from("usage_counters")
    .select("used")
    .eq("user_id", userId).eq("counter_type", "daily_requests").eq("period_start", period)
    .maybeSingle();
  return data?.used ?? 0;
}

async function main() {
  const bench = await resolveUser(BENCH_EMAIL);
  const starter = await resolveUser(STARTER_EMAIL);
  check("benchmark account is free tier (as expected)", bench.plan_tier === "free", bench.plan_tier);
  check("QA account is starter tier (as expected)", starter.plan_tier === "starter", starter.plan_tier);

  // ---- mint a real `authenticated`-role session for the benchmark account
  console.log("\n== 0. Mint a real authenticated JWT for the benchmark account ==");
  const { data: linkData, error: linkError } = await db.auth.admin.generateLink({ type: "magiclink", email: BENCH_EMAIL });
  if (linkError) throw new Error(`generateLink failed: ${linkError.message}`);
  const { data: otpData, error: otpError } = await anon.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: "magiclink",
  });
  if (otpError) throw new Error(`verifyOtp failed: ${otpError.message}`);
  const accessToken = otpData.session.access_token;
  check("obtained a real session access_token for the benchmark account", Boolean(accessToken), `len=${accessToken?.length}`);
  const authed = createClient(backendEnv.SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  const TARGETS = [
    { name: "reserve_daily_request", params: { p_user_id: bench.id } },
    { name: "release_daily_request", params: { p_user_id: bench.id } },
    {
      name: "consume_credits",
      params: {
        p_user_id: bench.id, p_credit_cost: 1, p_intent: "rpc_privilege_audit_probe",
        p_complexity: "simple", p_openrouter_model_id: "rpc-privilege-audit/synthetic",
        p_real_cost_estimate: 0, p_real_input_tokens: null, p_real_output_tokens: null,
        p_skip_daily_request: true,
      },
    },
  ];

  // ---- 1. anon role — every call must be denied at the grant layer -------
  console.log("\n== 1. anon role — expect permission denied (42501) on all three ==");
  for (const t of TARGETS) {
    const { error } = await anon.rpc(t.name, t.params);
    check(`anon.${t.name} denied at the privilege layer`, isPermissionDenied(error), error ? `${error.code}: ${error.message}` : "NO ERROR — call succeeded!");
  }

  // ---- 2. authenticated role (real benchmark-account JWT) — same --------
  console.log("\n== 2. authenticated role (benchmark account JWT) — expect permission denied (42501) on all three ==");
  for (const t of TARGETS) {
    const { error } = await authed.rpc(t.name, t.params);
    check(`authenticated.${t.name} denied at the privilege layer`, isPermissionDenied(error), error ? `${error.code}: ${error.message}` : "NO ERROR — call succeeded!");
  }

  // ---- 3. service_role — legitimate paths must still work ---------------
  console.log("\n== 3. service_role — legitimate paths still work (Free account) ==");
  {
    const period = new Date().toISOString().slice(0, 10);
    const before = await readDailyRequestsUsed(bench.id, period);
    try {
      const { data: r1, error: e1 } = await db.rpc("reserve_daily_request", { p_user_id: bench.id });
      check("service_role reserve_daily_request succeeds", !e1 && r1 === true, e1?.message ?? `used ${before} → ${await readDailyRequestsUsed(bench.id, period)}`);
      const { error: e2 } = await db.rpc("release_daily_request", { p_user_id: bench.id });
      check("service_role release_daily_request succeeds and restores the counter",
        !e2 && (await readDailyRequestsUsed(bench.id, period)) === before,
        e2?.message ?? `used=${await readDailyRequestsUsed(bench.id, period)}`);
    } finally {
      await db.from("usage_counters").update({ used: before })
        .eq("user_id", bench.id).eq("counter_type", "daily_requests").eq("period_start", period);
    }
  }

  // ---- 4. Starter account — same RPC/tier-driven logic, different limit -
  console.log("\n== 4. service_role — Starter account daily-request accounting ==");
  {
    const period = new Date().toISOString().slice(0, 10);
    const before = await readDailyRequestsUsed(starter.id, period);
    try {
      const { data: r1, error: e1 } = await db.rpc("reserve_daily_request", { p_user_id: starter.id });
      check("service_role reserve_daily_request succeeds for a Starter account", !e1 && r1 === true, e1?.message);
      const { error: e2 } = await db.rpc("release_daily_request", { p_user_id: starter.id });
      check("service_role release_daily_request restores the Starter counter",
        !e2 && (await readDailyRequestsUsed(starter.id, period)) === before, e2?.message);
    } finally {
      await db.from("usage_counters").update({ used: before })
        .eq("user_id", starter.id).eq("counter_type", "daily_requests").eq("period_start", period);
    }
  }

  // ---- 5. service_role — consume_credits still works, no daily-request
  //         side effect, and cleans up after itself -----------------------
  console.log("\n== 5. service_role — consume_credits (skipDailyRequest) still works ==");
  {
    const creditPeriod = new Date().toISOString().slice(0, 10); // matches get_period_start's monthly/credits keying close enough for a same-day probe
    const { data: beforeCounter } = await db.from("usage_counters").select("period_start, used")
      .eq("user_id", bench.id).eq("counter_type", "credits").order("period_start", { ascending: false }).limit(1).maybeSingle();
    const requestPeriod = new Date().toISOString().slice(0, 10);
    const dailyBefore = await readDailyRequestsUsed(bench.id, requestPeriod);
    const { count: logsBefore } = await db.from("credit_usage_logs")
      .select("id", { count: "exact", head: true }).eq("user_id", bench.id).eq("intent", "rpc_privilege_audit_probe");

    const { error: consumeErr } = await db.rpc("consume_credits", TARGETS[2].params);
    check("service_role consume_credits succeeds", !consumeErr, consumeErr?.message);

    const { data: afterCounter } = await db.from("usage_counters").select("used")
      .eq("user_id", bench.id).eq("counter_type", "credits").eq("period_start", beforeCounter?.period_start ?? creditPeriod).maybeSingle();
    check("usage_counters.credits incremented by exactly 1",
      (afterCounter?.used ?? 0) === (beforeCounter?.used ?? 0) + 1,
      `${beforeCounter?.used ?? 0} → ${afterCounter?.used ?? 0}`);

    const { count: logsAfter } = await db.from("credit_usage_logs")
      .select("id", { count: "exact", head: true }).eq("user_id", bench.id).eq("intent", "rpc_privilege_audit_probe");
    check("credit_usage_logs gained exactly one row", (logsAfter ?? 0) === (logsBefore ?? 0) + 1, `${logsBefore} → ${logsAfter}`);

    check("p_skip_daily_request:true caused NO daily_requests mutation",
      (await readDailyRequestsUsed(bench.id, requestPeriod)) === dailyBefore,
      `used=${await readDailyRequestsUsed(bench.id, requestPeriod)}`);

    // cleanup: remove the synthetic ledger row and the +1 it added
    await db.from("credit_usage_logs").delete().eq("user_id", bench.id).eq("intent", "rpc_privilege_audit_probe");
    if (beforeCounter) {
      await db.from("usage_counters").update({ used: beforeCounter.used })
        .eq("user_id", bench.id).eq("counter_type", "credits").eq("period_start", beforeCounter.period_start);
    } else if (afterCounter) {
      await db.from("usage_counters").delete()
        .eq("user_id", bench.id).eq("counter_type", "credits").eq("period_start", creditPeriod);
    }
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
