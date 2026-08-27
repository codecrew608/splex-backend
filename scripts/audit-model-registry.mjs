#!/usr/bin/env node
// Audits model_registry against OpenRouter's live catalogue.
//
// This exists because the production outage of 2026-08-27 was entirely
// preventable: nvidia/nemotron-nano-9b-v2:free had been withdrawn upstream,
// nothing noticed, and Free-tier chat died the moment the primary model hit
// a transient error and fell back to a model that 404s.
//
// The backend now self-heals at request time (a 404 deactivates the row —
// see cortex/modelHealth.ts), but that is REACTIVE: the first user to hit a
// dead model still gets a degraded response. This is the proactive half, and
// it's read-only — it reports, it never writes.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/audit-model-registry.mjs
//
// Exit codes: 0 = healthy, 1 = problems found (so CI/cron can alert).

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(2);
}

const catalogue = await fetch("https://openrouter.ai/api/v1/models")
  .then((r) => r.json())
  .catch((err) => {
    console.error("Could not reach OpenRouter:", err.message);
    process.exit(2);
  });

const live = new Map(catalogue.data.map((m) => [m.id, m]));

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const { data: rows, error } = await supabase
  .from("model_registry")
  .select("openrouter_model_id, variant, category, is_active, priority")
  .eq("is_active", true);

if (error) {
  console.error("model_registry query failed:", error.message);
  process.exit(2);
}

const stale = rows.filter((r) => !live.has(r.openrouter_model_id));

// Candidate depth per (variant, category). A category down to ONE active
// model is the exact shape that caused the outage: one upstream retirement
// away from having no fallback at all.
const depth = new Map();
for (const r of rows) {
  const key = `${r.variant}/${r.category}`;
  if (!depth.has(key)) depth.set(key, { total: 0, liveCount: 0 });
  const d = depth.get(key);
  d.total += 1;
  if (live.has(r.openrouter_model_id)) d.liveCount += 1;
}

const empty = [...depth.entries()].filter(([, d]) => d.liveCount === 0);
const thin = [...depth.entries()].filter(([, d]) => d.liveCount === 1);

console.log(`Registry audit — ${rows.length} active rows vs ${live.size} live OpenRouter models\n`);

if (stale.length) {
  console.log(`STALE (active but not on OpenRouter) — ${stale.length}:`);
  for (const r of stale) console.log(`  [${r.variant}] ${r.category.padEnd(11)} ${r.openrouter_model_id}`);
  console.log();
}

if (empty.length) {
  console.log(`NO LIVE CANDIDATE — ${empty.length} (these categories cannot serve a request):`);
  for (const [k] of empty) console.log(`  ${k}`);
  console.log();
}

if (thin.length) {
  console.log(`SINGLE POINT OF FAILURE — ${thin.length} (one retirement from dead):`);
  for (const [k] of thin) console.log(`  ${k}`);
  console.log();
}

if (!stale.length && !empty.length && !thin.length) {
  console.log("Healthy: every active model is live, and every category has at least two.");
  process.exit(0);
}
process.exit(1);
