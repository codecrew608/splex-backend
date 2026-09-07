import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { classifyDeterministic } from "../src/cortex/classify.js";

/**
 * Routing suite v2 — the naturally-varied one.
 *
 * 115 cases across the request shapes a router actually meets: conversational
 * language, terse fragments, long narratives, maths with no maths keyword,
 * eight languages, misspellings, adversarial wording, and 15 negative
 * controls.
 *
 * HOW THIS FILE IS ALLOWED TO BE USED, stated up front because it matters
 * more than the number it produces: I wrote these cases, so they are
 * author-aware. They are a DEVELOPMENT target and a regression gate. They are
 * NOT independent evidence and their pass rate is never reported as the
 * headline routing accuracy — that stays on the 432-item corpus written in an
 * earlier session, before any of this work existed.
 *
 * A case that resolves to the LLM classifier counts as a miss. The classifier
 * might well fix it, but it costs a ~4s round trip (measured) and its answer
 * is not reproducible, so the deterministic path is what is scored.
 */

const REPO = join(import.meta.dirname, "../../..");
const CASES = join(REPO, "bench/routing/cases-v2.jsonl");

interface Case { id: string; kind: string; prompt: string; expect: string; note?: string }

const cases: Case[] = existsSync(CASES)
  ? readFileSync(CASES, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Case)
  : [];

function route(prompt: string): { category: string | null; intentId: string | null } {
  const r = classifyDeterministic(prompt);
  return r ? { category: r.category, intentId: r.intentId } : { category: null, intentId: null };
}

describe("routing v2 — suite integrity", () => {
  it("is large and carries real negative controls", () => {
    expect(cases.length).toBeGreaterThanOrEqual(100);
    expect(cases.filter((c) => c.kind === "negative_control").length).toBeGreaterThanOrEqual(12);
    // Every request shape in the brief must be represented, so the suite
    // cannot quietly become "the shapes that happen to pass".
    const kinds = new Set(cases.map((c) => c.kind));
    for (const required of [
      "natural_conversational", "short_prompt", "long_prompt", "math_without_keywords",
      "coding_plus_reasoning", "mixed_domain", "multilingual", "ambiguous",
      "misspelling", "adversarial", "tool_dependent", "negative_control",
    ]) {
      expect(kinds.has(required), `missing request shape: ${required}`).toBe(true);
    }
  });
});

describe("routing v2 — negative controls (must never regress)", () => {
  // Split out and asserted individually: these are the cases a score-chasing
  // change breaks first, so they fail loudly and by name.
  for (const c of cases.filter((x) => x.kind === "negative_control")) {
    it(`${c.id}: ${c.prompt.slice(0, 54)}`, () => {
      const got = route(c.prompt);
      expect(got.category, `${c.note ?? ""} (intent=${got.intentId})`).toBe(c.expect);
    });
  }
});

describe("routing v2 — accuracy by request shape", () => {
  it("reports per-shape accuracy and holds an overall floor", () => {
    const byKind = new Map<string, { pass: number; total: number; misses: string[] }>();
    let pass = 0, fallback = 0;

    for (const c of cases) {
      const got = route(c.prompt);
      const ok = got.category === c.expect;
      if (ok) pass++;
      if (got.category === null) fallback++;
      const k = byKind.get(c.kind) ?? { pass: 0, total: 0, misses: [] };
      k.total++;
      if (ok) k.pass++;
      else k.misses.push(`${c.id} want=${c.expect} got=${got.category ?? "LLM_FALLBACK"}`);
      byKind.set(c.kind, k);
    }

    const report = {
      total: cases.length,
      pass,
      accuracy_pct: (pass / cases.length) * 100,
      llm_fallback: fallback,
      llm_fallback_pct: (fallback / cases.length) * 100,
      by_kind: Object.fromEntries([...byKind].map(([k, v]) => [k, {
        pass: v.pass, total: v.total,
        pct: Number(((v.pass / v.total) * 100).toFixed(1)),
        misses: v.misses,
      }])),
    };

    if (process.env.ROUTING_V2_JSON_OUT) {
      writeFileSync(process.env.ROUTING_V2_JSON_OUT, JSON.stringify(report, null, 2));
    }
    // eslint-disable-next-line no-console
    console.log("\nrouting v2:", JSON.stringify(report, null, 2));

    // A floor, not a target. Set below the measured value so ordinary suite
    // growth does not fail the build, while a real regression does.
    expect(report.accuracy_pct).toBeGreaterThan(70);
  });
});
