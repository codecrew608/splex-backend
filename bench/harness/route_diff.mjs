/**
 * Shows which specific corpus items a routing change moved, and in which
 * direction. A headline accuracy number can improve while a change quietly
 * makes a whole class of question worse; this prints the actual items so
 * that trade is visible instead of averaged away.
 *
 * Run with the built classifier on the current working tree; compare the
 * output against a run from before the change.
 */

import { readFileSync, writeFileSync } from "node:fs";

const [outPath, ...corpusPaths] = process.argv.slice(2);
if (!outPath) {
  console.error("usage: route_diff.mjs <out.json> <corpus.jsonl...>");
  process.exit(2);
}

const { classifyDeterministic } = await import(
  "../../apps/backend/dist/cortex/classify.js"
);

const readJsonl = (p) =>
  readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

const rows = corpusPaths.flatMap(readJsonl);
const out = rows.map((q) => {
  const r = classifyDeterministic(q.prompt);
  return {
    question_id: q.question_id,
    category: q.category,
    expected: q.expected_capability,
    got: r ? r.category : null,
    intent: r ? r.intentId : null,
    prompt: q.prompt.slice(0, 110),
  };
});

writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`wrote ${outPath} (${out.length} rows)`);
