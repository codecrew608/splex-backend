/**
 * Minimal live read of Groq's CURRENT rate-limit headers for the SPLEX
 * fallback model — one tiny non-streaming completion, no streaming, ~10
 * output tokens. Free tier ($0), one request against a rolling ~86s
 * window. Prints every x-ratelimit* / retry-after header verbatim so the
 * GROQ_TOTAL_DAILY_CAPACITY doc reconciliation is grounded in what Groq
 * reports today, not a months-old note.
 *
 * Run:  node bench/groq-limits-probe.mjs
 */
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
if (!env.GROQ_API_KEY) {
  console.error("GROQ_API_KEY not set — nothing to probe.");
  process.exit(2);
}

const model = env.GROQ_FALLBACK_MODEL || "openai/gpt-oss-120b";
const base = env.GROQ_BASE_URL || "https://api.groq.com/openai/v1";

const res = await fetch(`${base}/chat/completions`, {
  method: "POST",
  headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model, messages: [{ role: "user", content: "reply with the single word: ok" }], max_tokens: 8, stream: false }),
});

console.log(`\nGroq ${model} — HTTP ${res.status}\n`);
const wanted = [];
for (const [k, v] of res.headers.entries()) {
  if (/ratelimit|retry-after/i.test(k)) wanted.push([k, v]);
}
wanted.sort();
for (const [k, v] of wanted) console.log(`  ${k}: ${v}`);

const body = await res.json().catch(() => ({}));
if (res.ok) {
  console.log(`\n  completion: ${JSON.stringify(body.choices?.[0]?.message?.content ?? "")}`);
  console.log(`  usage: ${JSON.stringify(body.usage ?? {})}`);
} else {
  console.log(`\n  error body: ${JSON.stringify(body).slice(0, 300)}`);
}
