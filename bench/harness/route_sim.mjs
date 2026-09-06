/**
 * Offline routing simulator — runs SPLEX's REAL intent table and REAL
 * decision logic over the whole corpus, with no network call and no cost.
 *
 * Why this exists: the live run can only afford ~70 routing observations
 * before it exhausts a Free tier's daily request budget. Routing, though, is
 * pure computation up to the point where the LLM fallback is invoked — so
 * for every message that resolves deterministically (which, as it turns out,
 * is most of them) the decision can be reproduced exactly, offline, for the
 * entire 432-item corpus.
 *
 * Fidelity is not assumed. This imports INTENTS from the production
 * `cortex/intents.ts` rather than restating it, and the decision function
 * below is a line-for-line transcription of `classifyIntent`'s deterministic
 * path in `cortex/classify.ts`. `validate.py` then checks the simulator
 * against every routing decision the live run actually produced; a single
 * mismatch invalidates the simulation rather than being averaged away.
 *
 * Messages that reach the LLM fallback are reported as `llm_fallback`, never
 * guessed at — their outcome is genuinely non-deterministic and belongs in
 * the live measurement, not here.
 */

import { readFileSync } from "node:fs";
import { INTENTS } from "../../apps/backend/src/cortex/intents.ts";

const GREETING_RE = /^(hi|hey|hello|yo|sup|hiya)[!.? ]*$/i;

function scoreIntents(message) {
  return INTENTS.map((intent) => ({
    intent,
    strongHits: intent.strongKeywords.filter((re) => re.test(message)).length,
    weakHits: intent.weakKeywords.filter((re) => re.test(message)).length,
  }));
}

/** Transcription of classifyIntent()'s deterministic path, in order. */
function classify(message) {
  if (GREETING_RE.test(message.trim())) {
    return { category: "general", via: "greeting", intentId: "general_qa" };
  }

  const scored = scoreIntents(message);
  const strong = scored.filter((s) => s.strongHits > 0);

  if (strong.length === 1) {
    return { category: strong[0].intent.category, via: "strong_keyword",
             intentId: strong[0].intent.id };
  }

  if (strong.length === 0) {
    const weak = scored.filter((s) => s.weakHits > 0).sort((a, b) => b.weakHits - a.weakHits);
    if (weak.length === 1 || (weak.length > 1 && weak[0].weakHits > weak[1].weakHits)) {
      return { category: weak[0].intent.category, via: "weak_keyword",
               intentId: weak[0].intent.id };
    }
  }

  // Ambiguous (several intents tied) — the real system asks an LLM here, so
  // the outcome is not reproducible offline and is reported as such.
  return {
    category: null, via: "llm_fallback", intentId: null,
    tiedStrong: strong.map((s) => s.intent.id),
  };
}

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("usage: route_sim.mjs <corpus.jsonl> [more.jsonl ...]");
  process.exit(2);
}

const out = [];
for (const p of paths) {
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const q = JSON.parse(line);
    const r = classify(q.prompt);
    out.push({
      question_id: q.question_id,
      corpus_category: q.category,
      expected_capability: q.expected_capability,
      predicted_category: r.category,
      via: r.via,
      intent_id: r.intentId,
      tied_strong: r.tiedStrong ?? null,
    });
  }
}
process.stdout.write(out.map((r) => JSON.stringify(r)).join("\n") + "\n");
