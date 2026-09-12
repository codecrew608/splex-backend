/**
 * Live verification for reap_stale_streaming_messages() (migration 0066) —
 * the out-of-band recovery for an assistant message stuck in 'streaming'
 * forever (real production incident, 2026-09-12; see the migration's own
 * doc comment for the full story).
 *
 * SAFETY — every row this probe creates lives in a throwaway project +
 * conversation under the isolated benchmark account
 * (sib-bench-v1@splex-benchmark.invalid), deleted in a finally block. The
 * only pre-existing state this probe reads or restores is that account's
 * own daily_requests counter (snapshot/restore, same discipline as
 * free-routing-verify.mjs).
 *
 * Run:  node bench/stale-message-reap-verify.mjs
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

async function resolveBenchUser() {
  if (process.env.SPLEX_BENCH_USER_ID) return process.env.SPLEX_BENCH_USER_ID;
  const { data } = await db.from("users").select("id").eq("email", "sib-bench-v1@splex-benchmark.invalid").maybeSingle();
  if (!data) throw new Error("sib-bench-v1@splex-benchmark.invalid not found");
  return data.id;
}

async function readDailyRequestsUsed(userId, period) {
  const { data } = await db.from("usage_counters").select("used")
    .eq("user_id", userId).eq("counter_type", "daily_requests").eq("period_start", period).maybeSingle();
  return data?.used ?? 0;
}

async function main() {
  const BENCH_USER = await resolveBenchUser();
  const period = new Date().toISOString().slice(0, 10);
  const OLD = new Date(Date.now() - 10 * 60_000).toISOString(); // 10 min ago — well past any real deadline
  const RECENT = new Date().toISOString();

  const before = await readDailyRequestsUsed(BENCH_USER, period);

  const { data: project, error: projectError } = await db.from("projects")
    .insert({ user_id: BENCH_USER, title: "stale-message-reap-verify", type: "chat", is_implicit: true })
    .select("id").single();
  if (projectError) throw new Error(`create project: ${projectError.message}`);

  const { data: conversation, error: conversationError } = await db.from("conversations")
    .insert({ project_id: project.id, title: "stale-message-reap-verify" })
    .select("id").single();
  if (conversationError) throw new Error(`create conversation: ${conversationError.message}`);

  let reservedStaleId, unreservedStaleId, freshStreamingId;
  try {
    // Bump the counter by 1 to simulate reserveDailyRequest() having run for
    // the "reserved" stale message below — mirrors real production shape
    // rather than asserting against a bare 0.
    await db.from("usage_counters").upsert(
      { user_id: BENCH_USER, counter_type: "daily_requests", period_start: period, used: before + 1 },
      { onConflict: "user_id,counter_type,period_start" },
    );

    const insertStale = (reserved) =>
      db.from("messages").insert({
        conversation_id: conversation.id, role: "assistant", content: "",
        status: "streaming", reserved_daily_request: reserved, created_at: OLD,
      }).select("id").single();

    const [r1, r2] = await Promise.all([insertStale(true), insertStale(false)]);
    if (r1.error || r2.error) throw new Error(`seed stale rows: ${r1.error?.message ?? r2.error?.message}`);
    reservedStaleId = r1.data.id;
    unreservedStaleId = r2.data.id;

    const { data: fresh, error: freshError } = await db.from("messages").insert({
      conversation_id: conversation.id, role: "assistant", content: "",
      status: "streaming", reserved_daily_request: true, created_at: RECENT,
    }).select("id").single();
    if (freshError) throw new Error(`seed fresh row: ${freshError.message}`);
    freshStreamingId = fresh.data?.id ?? fresh.id;

    // A generous-but-short window (30s) so the FRESH row (just now) survives
    // while both 10-minute-old rows are reaped.
    const { data: reapedCount, error: reapError } = await db.rpc("reap_stale_streaming_messages", { p_stale_after: "30 seconds" });
    if (reapError) throw new Error(`reap RPC failed: ${reapError.message}`);
    check("reaped exactly the 2 stale rows, not the fresh one", reapedCount === 2, `reaped=${reapedCount}`);

    const { data: rows } = await db.from("messages").select("id, status, content, reserved_daily_request")
      .in("id", [reservedStaleId, unreservedStaleId, freshStreamingId]);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    check("reserved-stale row finalized as failed with the standard message",
      byId[reservedStaleId]?.status === "failed" && byId[reservedStaleId]?.content === "Something went wrong while generating this. Please try again.");
    check("unreserved-stale row also finalized as failed",
      byId[unreservedStaleId]?.status === "failed");
    check("fresh (30s-window-safe) row untouched — still streaming",
      byId[freshStreamingId]?.status === "streaming");

    check("daily_requests released by exactly 1 (only the reserved row)",
      (await readDailyRequestsUsed(BENCH_USER, period)) === before,
      `before=${before}, after=${await readDailyRequestsUsed(BENCH_USER, period)}`);

    const { data: reapedAgain } = await db.rpc("reap_stale_streaming_messages", { p_stale_after: "30 seconds" });
    check("re-running the reap is idempotent — nothing left to reap", reapedAgain === 0, `reaped=${reapedAgain}`);
  } finally {
    await db.from("messages").delete().in("id", [reservedStaleId, unreservedStaleId, freshStreamingId].filter(Boolean));
    await db.from("conversations").delete().eq("id", conversation.id);
    await db.from("projects").delete().eq("id", project.id);
    await db.from("usage_counters").update({ used: before })
      .eq("user_id", BENCH_USER).eq("counter_type", "daily_requests").eq("period_start", period);
    check("bench account daily_requests restored to its prior value", (await readDailyRequestsUsed(BENCH_USER, period)) === before);
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
