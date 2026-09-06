import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { classifyDeterministic } from "../src/cortex/classify.js";

/**
 * Routing regression suite.
 *
 * Exercises the REAL deterministic classifier (imported, not transcribed) so
 * a passing suite says something about production rather than about a copy.
 *
 * Two halves, and the second is the one that keeps the first honest:
 *
 *   1. Hand-labelled cases in bench/routing/cases.jsonl, roughly half of them
 *      deliberate NEGATIVES — "What is the capital of France?" must stay
 *      general. A change that fixed maths routing by sending everything to
 *      maths would sail through the positives and fail here, which is
 *      precisely what this file exists to prevent.
 *   2. A sweep of the whole benchmark corpus, reporting strict/acceptable
 *      accuracy AND the LLM-fallback rate. Every fallback is an extra model
 *      round-trip on the critical path, so it is a latency and cost number
 *      as much as a routing one.
 *
 * The corpus files live outside this package; when they are absent (a fresh
 * checkout without bench/) the sweep skips rather than failing the build.
 */

const REPO = join(import.meta.dirname, "../../..");
const CASES = join(REPO, "bench/routing/cases.jsonl");
const CORPUS = [
  join(REPO, "bench/corpus/corpus.jsonl"),
  join(REPO, "bench/corpus/sib_ext.jsonl"),
];

interface Case { id: string; prompt: string; expect: string; note?: string }

const readJsonl = <T>(p: string): T[] =>
  readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);

/** null category means the real system would pay for the LLM classifier. */
function route(prompt: string): { category: string | null; intentId: string | null } {
  const r = classifyDeterministic(prompt);
  return r ? { category: r.category, intentId: r.intentId } : { category: null, intentId: null };
}

// Same tolerance table the benchmark scores against: `general` is the
// router's declared catch-all, so a maths question answered by a general
// model is a weaker route, not a broken one. Reported separately from strict.
const ACCEPTABLE: Record<string, Set<string>> = {
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

describe("routing regression — labelled cases", () => {
  const cases = existsSync(CASES) ? readJsonl<Case>(CASES) : [];

  it("has a corpus of labelled cases including negatives", () => {
    expect(cases.length).toBeGreaterThan(30);
    const negatives = cases.filter((c) => (c.note ?? "").includes("NEGATIVE"));
    expect(negatives.length).toBeGreaterThanOrEqual(8);
  });

  for (const c of cases) {
    it(`${c.id}: ${c.prompt.slice(0, 56)}`, () => {
      const got = route(c.prompt);
      // A fallback is not a pass: the LLM might fix it, but it costs a
      // round-trip and its answer is not reproducible.
      expect(got.category, `${c.note ?? ""} (intent=${got.intentId})`).toBe(c.expect);
    });
  }
});

describe("routing regression — corpus sweep", () => {
  it("reports strict/acceptable accuracy and the LLM-fallback rate", () => {
    const present = CORPUS.filter(existsSync);
    if (present.length === 0) return;   // bench/ not checked out

    const rows = present.flatMap((p) =>
      readJsonl<{ prompt: string; expected_capability: string }>(p));

    let strict = 0, acceptable = 0, deterministic = 0, fallback = 0;
    const confusion = new Map<string, number>();

    for (const q of rows) {
      const got = route(q.prompt);
      if (got.category === null) { fallback++; continue; }
      deterministic++;
      const want = q.expected_capability;
      if (got.category === want) strict++;
      if ((ACCEPTABLE[want] ?? new Set([want])).has(got.category)) acceptable++;
      const k = `${want} -> ${got.category}`;
      confusion.set(k, (confusion.get(k) ?? 0) + 1);
    }

    const report = {
      total: rows.length,
      deterministic,
      fallback,
      fallback_pct: (fallback / rows.length) * 100,
      strict_pct: deterministic ? (strict / deterministic) * 100 : null,
      acceptable_pct: deterministic ? (acceptable / deterministic) * 100 : null,
      confusion: Object.fromEntries([...confusion].sort((a, b) => b[1] - a[1]).slice(0, 12)),
    };

    if (process.env.ROUTING_JSON_OUT) {
      writeFileSync(process.env.ROUTING_JSON_OUT, JSON.stringify(report, null, 2));
    }
    // eslint-disable-next-line no-console
    console.log("\nrouting corpus sweep:", JSON.stringify(report, null, 2));

    // Guard rails, not targets. These are floors the suite refuses to fall
    // below; they are deliberately set under the measured value so ordinary
    // corpus growth does not fail the build, while a real regression does.
    expect(report.strict_pct).not.toBeNull();
    expect(report.fallback_pct).toBeLessThan(45);
    expect(report.acceptable_pct!).toBeGreaterThan(85);
  });
});
