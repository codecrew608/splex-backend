/**
 * Routing regression suite.
 *
 * Runs SPLEX's REAL deterministic classifier — `classifyDeterministic` from
 * `cortex/classify.ts`, imported, not transcribed — over two inputs:
 *
 *   1. bench/routing/cases.jsonl — hand-labelled cases, including deliberate
 *      NEGATIVES ("What is the capital of France?" must stay general). The
 *      negatives are the point: a change that routes maths correctly by
 *      routing everything to maths must fail this suite, not pass it.
 *   2. the full corpus — for corpus-wide strict/acceptable accuracy and,
 *      just as importantly, the LLM-fallback rate, since every fallback is
 *      an extra model round-trip on the critical path.
 *
 * Exit code is non-zero if any labelled case fails, so this can gate a change.
 */

import { readFileSync } from "node:fs";
import { classifyDeterministic } from "../../apps/backend/src/cortex/classify.ts";

const ACCEPTABLE = {
  math: new Set(["math", "reasoning", "general"]),
  reasoning: new Set(["reasoning", "math", "general"]),
  coding: new Set(["coding", "general", "reasoning"]),
  general: new Set(["general", "reasoning", "writing"]),
  documents: new Set(["documents", "general", "reasoning"]),
  writing: new Set(["writing", "general"]),
  web_search: new Set(["web_search", "general"]),
  vision: new Set(["vision", "documents", "general"]),
  unavailable: new Set(["image", "audio", "video", "ppt", "general"]),
};

const readJsonl = (p) =>
  readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

/** null category == the real system would call the LLM classifier here. */
function route(prompt) {
  const r = classifyDeterministic(prompt);
  return r ? { category: r.category, intentId: r.intentId, fallback: false }
           : { category: null, intentId: null, fallback: true };
}

// ---------------------------------------------------------------------------
// 1. labelled cases
// ---------------------------------------------------------------------------
const casesPath = process.argv[2] ?? "bench/routing/cases.jsonl";
const cases = readJsonl(casesPath);

let pass = 0;
const failures = [];
console.log(`== labelled routing cases (${cases.length}) ==`);
for (const c of cases) {
  const got = route(c.prompt);
  // A fallback is not a pass. The LLM might well fix it, but it costs a
  // round-trip and its answer is not reproducible, so the suite counts only
  // decisions the deterministic path actually makes.
  const ok = got.category === c.expect;
  if (ok) pass++;
  else failures.push({ ...c, got: got.category, fallback: got.fallback, intentId: got.intentId });
}
console.log(`  ${pass}/${cases.length} exact (${((pass / cases.length) * 100).toFixed(1)}%)`);
if (failures.length) {
  console.log("  failures:");
  for (const f of failures) {
    const g = f.fallback ? "LLM_FALLBACK" : f.got;
    console.log(`    ${f.id.padEnd(14)} want=${String(f.expect).padEnd(11)} got=${String(g).padEnd(13)} ${f.prompt.slice(0, 58)}`);
  }
}

// ---------------------------------------------------------------------------
// 2. corpus-wide
// ---------------------------------------------------------------------------
const corpusPaths = process.argv.slice(3);
let corpusReport = null;
if (corpusPaths.length) {
  const rows = corpusPaths.flatMap(readJsonl);
  let strict = 0, acceptable = 0, deterministic = 0, fallback = 0;
  const confusion = new Map();
  for (const q of rows) {
    const got = route(q.prompt);
    if (got.fallback) { fallback++; continue; }
    deterministic++;
    const want = q.expected_capability;
    if (got.category === want) strict++;
    if ((ACCEPTABLE[want] ?? new Set([want])).has(got.category)) acceptable++;
    const k = `${want} -> ${got.category}`;
    confusion.set(k, (confusion.get(k) ?? 0) + 1);
  }
  corpusReport = {
    total: rows.length, deterministic, fallback,
    fallback_pct: (fallback / rows.length) * 100,
    strict_pct: deterministic ? (strict / deterministic) * 100 : null,
    acceptable_pct: deterministic ? (acceptable / deterministic) * 100 : null,
  };
  console.log(`\n== corpus-wide (${rows.length} items) ==`);
  console.log(`  resolved deterministically : ${deterministic} (${(100 - corpusReport.fallback_pct).toFixed(1)}%)`);
  console.log(`  sent to the LLM classifier : ${fallback} (${corpusReport.fallback_pct.toFixed(1)}%)`);
  console.log(`  strict accuracy            : ${corpusReport.strict_pct.toFixed(1)}%  (of resolved)`);
  console.log(`  acceptable accuracy        : ${corpusReport.acceptable_pct.toFixed(1)}%`);
  console.log("  top confusions:");
  for (const [k, v] of [...confusion].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`    ${k.padEnd(32)} ${v}`);
  }
}

if (process.env.ROUTING_JSON_OUT) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.env.ROUTING_JSON_OUT, JSON.stringify({
    cases: { total: cases.length, pass, failures }, corpus: corpusReport,
  }, null, 2));
}

process.exit(failures.length ? 1 : 0);
