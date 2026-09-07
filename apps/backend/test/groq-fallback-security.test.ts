import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Security review, migration 0056 (Groq fallback). Same structural-pin
// idiom capacity-security.test.ts already uses for the OpenRouter capacity
// gate, applied to this new surface — a test that reads the real file
// fails the moment the guarantee it pins stops holding; a comment does not.

const SRC = join(import.meta.dirname, "..", "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("Groq fallback — exactly one integration point", () => {
  it("attemptGroqFallback is called from exactly one place in the whole backend (handlers/chat.ts)", () => {
    let callSites = 0;
    for (const file of walk(SRC)) {
      if (file.endsWith("groq/fallback.ts")) continue; // the definition itself
      const src = readFileSync(file, "utf8");
      if (src.includes("attemptGroqFallback(")) {
        callSites++;
        expect(file.endsWith("handlers/chat.ts"), `unexpected call site: ${file}`).toBe(true);
      }
    }
    expect(callSites).toBe(1);
  });

  it("admit_groq_fallback_request is never called directly outside groq/capacity.ts", () => {
    let directCallSites = 0;
    for (const file of walk(SRC)) {
      if (file.endsWith("groq/capacity.ts")) continue;
      const src = readFileSync(file, "utf8");
      if (src.includes('"admit_groq_fallback_request"')) directCallSites++;
    }
    expect(directCallSites).toBe(0);
  });

  it("streamGroqCompletion has exactly one call site (groq/fallback.ts)", () => {
    let callSites = 0;
    for (const file of walk(SRC)) {
      if (file.endsWith("groq/client.ts")) continue;
      const src = readFileSync(file, "utf8");
      if (src.includes("streamGroqCompletion(")) {
        callSites++;
        expect(file.endsWith("groq/fallback.ts"), `unexpected call site: ${file}`).toBe(true);
      }
    }
    expect(callSites).toBe(1);
  });
});

describe("Groq fallback — Free AND Paid, but with a tier-DIFFERENT trigger rule, structurally", () => {
  // Extended to Paid 2026-09-07 (user's explicit direction). The tier gate
  // is no longer "reject Paid outright" — it's "use a different eligible-
  // failure predicate per tier", enforced inside isEligibleFailure. This
  // pins the one property that actually matters now: Free's predicate
  // (isOpenRouterCapacityExhausted) structurally never includes a 402
  // check, while the combined per-tier check explicitly re-admits 402 only
  // for a non-free planTier.
  it("isOpenRouterCapacityExhausted (the tier-SHARED predicate) never references balance/402 at all", () => {
    const src = read("groq/fallback.ts");
    const fnStart = src.indexOf("export function isOpenRouterCapacityExhausted(");
    const fnEnd = src.indexOf("\n}", fnStart);
    const fnBody = src.slice(fnStart, fnEnd);
    expect(fnBody).not.toMatch(/isBalanceExceededError|402/);
  });

  it("isEligibleFailure re-admits isBalanceExceededError ONLY when planTier !== \"free\"", () => {
    const src = read("groq/fallback.ts");
    const fnStart = src.indexOf("function isEligibleFailure(");
    const fnBody = src.slice(fnStart, fnStart + 300);
    expect(fnBody).toContain('planTier !== "free" && isBalanceExceededError(err)');
  });

  it("GROQ_API_KEY is still checked before any dispatch attempt, for both tiers alike", () => {
    const src = read("groq/fallback.ts");
    const fnStart = src.indexOf("export async function attemptGroqFallback(");
    const fnBody = src.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain("if (!fastify.config.GROQ_API_KEY) return null;");
  });

  it("the chat.ts call site sources planTier from the server-resolved `user` object, never from the request body", () => {
    const src = read("handlers/chat.ts");
    const callAt = src.indexOf("attemptGroqFallback({");
    const call = src.slice(callAt, callAt + 400);
    expect(call).toContain("user,");
    expect(call).not.toMatch(/planTier:\s*body\./);
  });
});

describe("Groq fallback — a Paid-served turn is billed as a REAL paid dispatch, never as a free discount", () => {
  // Groq's own $0 cost to SPLEX must never leak into what a Paid user is
  // charged — buildGroqModel prices a Paid-tier synthetic row at a real,
  // non-zero rate (see fallback.ts's own header comment for the
  // incentive-alignment reasoning), exactly like every other paid dispatch.
  it("buildGroqModel sets non-zero cost_per_million figures ONLY for the paid branch", () => {
    const src = read("groq/fallback.ts");
    const fnStart = src.indexOf("function buildGroqModel(");
    const fnBody = src.slice(fnStart, src.indexOf("\n}", fnStart));
    expect(fnBody).toMatch(/cost_per_million_input:\s*isPaid\s*\?\s*[\d.]*[1-9]/);
    expect(fnBody).toMatch(/cost_per_million_output:\s*isPaid\s*\?\s*[\d.]*[1-9]/);
  });
});

describe("Groq fallback — Free and Paid can never exceed the one real shared account limit", () => {
  // resolveTierBudget must derive both slices from the SAME configured
  // total via a single subtraction (free = buffered - paid), never from
  // two independently-configured raw numbers that could silently sum past
  // the real Groq account ceiling.
  it("capacity.ts computes Free's slice as (bufferedTotal - paidSlice), not from a separate config value", () => {
    const src = read("groq/capacity.ts");
    expect(src).toContain("bufferedTotal - paidSlice");
    expect(src).not.toMatch(/GROQ_FREE_DAILY_CAPACITY/); // the old, pre-split, tier-blind config name must be gone
  });
});

describe("Groq fallback — admission runs before any real network call", () => {
  it("streamGroqCompletion calls admitGroqFallbackRequest BEFORE fetch()", () => {
    const src = read("groq/client.ts");
    const fnStart = src.indexOf("export async function streamGroqCompletion(");
    const admitAt = src.indexOf("admitGroqFallbackRequest", fnStart);
    const fetchAt = src.indexOf("await fetch(", fnStart);
    expect(admitAt).toBeGreaterThan(-1);
    expect(fetchAt).toBeGreaterThan(-1);
    expect(admitAt).toBeLessThan(fetchAt);
  });
});

describe("Groq fallback — never poisons SPLEX's own model-health/routing intelligence", () => {
  it("recordModelOutcome/recordModelFailure are never called from groq/ at all", () => {
    for (const rel of ["groq/client.ts", "groq/capacity.ts", "groq/fallback.ts"]) {
      const src = read(rel);
      expect(src, `${rel} must not call recordModelOutcome`).not.toContain("recordModelOutcome(");
      expect(src, `${rel} must not call recordModelFailure`).not.toContain("recordModelFailure(");
    }
  });

  it("the synthetic Groq model id ('groq-fallback') is never passed to a model_registry-keyed function", () => {
    // A real model_registry row id is a uuid; "groq-fallback" deliberately
    // is not, so it would corrupt telemetry for a random/nonexistent row if
    // it ever reached recordModelOutcome/recordModelFailure. This proves
    // the literal id string only ever appears where it's supposed to
    // (fallback.ts's own synthetic-row constructor).
    const fallbackSrc = read("groq/fallback.ts");
    const occurrences = (fallbackSrc.match(/groq-fallback/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(1);
    for (const file of walk(SRC)) {
      if (file.endsWith("groq/fallback.ts")) continue;
      const src = readFileSync(file, "utf8");
      expect(src, `${file} must not reference the synthetic id directly`).not.toContain("groq-fallback");
    }
  });
});

describe("Groq fallback — the ORIGINAL OpenRouter error is what the user sees on double failure", () => {
  it("chat.ts rethrows `err` (not a Groq-shaped error) whenever attemptGroqFallback returns null", () => {
    const src = read("handlers/chat.ts");
    const callAt = src.indexOf("const fallback = await attemptGroqFallback({");
    const block = src.slice(callAt, callAt + 700);
    expect(block).toContain("if (!fallback) throw err;");
  });
});

describe("Groq fallback — cannot be reached for a request SPLEX itself already forbids", () => {
  // Message B's own explicit rule: "If the request is already forbidden by
  // SPLEX: Do not call OpenRouter or Grok [Groq]." Both the credits gate
  // and the message-count reservation must resolve to "allowed" BEFORE the
  // generation attempt (and therefore attemptGroqFallback) is ever reached
  // — proven by source ORDER, mirroring this file's other before/after
  // pins rather than asserting it in prose.
  it("checkAndReserveCredits and reserveDailyRequest both run BEFORE attemptGroqFallback in chat.ts", () => {
    const src = read("handlers/chat.ts");
    const creditsGateAt = src.indexOf("const gate = await checkAndReserveCredits(");
    const requestGateAt = src.indexOf("const requestReserved = await reserveDailyRequest(");
    const fallbackAt = src.indexOf("attemptGroqFallback({");
    expect(creditsGateAt).toBeGreaterThan(-1);
    expect(requestGateAt).toBeGreaterThan(creditsGateAt);
    expect(fallbackAt).toBeGreaterThan(requestGateAt);
  });
});

describe("Groq fallback — no separate/duplicate credit-charging path", () => {
  // A Groq-served turn must be charged through the exact SAME
  // consumeCredits() call chat.ts already makes for an OpenRouter-served
  // turn (see fallback.ts's header: `model`/`generation` are reassigned so
  // every downstream line runs unchanged) — never a second charging path
  // that could double-charge, under-charge, or silently bypass the credit
  // ledger for "free" fallback usage. "One logical request, no
  // double-charging, no quota bypass" — this is the structural guarantee
  // behind that requirement.
  it("consumeCredits is never called from anywhere under groq/", () => {
    for (const rel of ["groq/client.ts", "groq/capacity.ts", "groq/fallback.ts"]) {
      expect(read(rel), `${rel} must not call consumeCredits directly`).not.toContain("consumeCredits(");
    }
  });
});

describe("Groq fallback — the API key is never exposed to a client", () => {
  it("GROQ_API_KEY is referenced only where the config schema, the header builder, or the on/off eligibility check need it — never interpolated into any user-facing string", () => {
    const allowed = ["groq/client.ts", "groq/fallback.ts", "plugins/env.ts", "worker/env.ts"];
    let usageSites = 0;
    for (const file of walk(SRC)) {
      const src = readFileSync(file, "utf8");
      if (src.includes("GROQ_API_KEY")) {
        usageSites++;
        expect(allowed.some((rel) => file.endsWith(rel)), `unexpected GROQ_API_KEY reference: ${file}`).toBe(true);
      }
    }
    expect(usageSites).toBeGreaterThanOrEqual(1);
  });
});
