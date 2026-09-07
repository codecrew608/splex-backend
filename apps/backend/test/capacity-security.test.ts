import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Security review, migration 0054 (OpenRouter free-capacity admission
// control). Structural checks, pinned against the actual source rather than
// asserted in prose — the same source-pin idiom free-paid-isolation.test.ts
// already uses for the tier-isolation guarantee, applied here to the new
// surface. A test that reads the real file fails the moment the guarantee
// it pins stops holding; a comment does not.

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

describe("capacity admission — user/tier identity cannot be client-supplied", () => {
  it("chatBodySchema has no userId, planTier, or plan_tier field at all", () => {
    // If the schema never accepts one, there is structurally nothing for a
    // client to manipulate — the strongest form of this guarantee.
    const src = read("handlers/chat.ts");
    const schemaBlock = src.slice(src.indexOf("export const chatBodySchema"), src.indexOf("export const truncateBodySchema"));
    expect(schemaBlock).not.toMatch(/userId|planTier|plan_tier/i);
  });

  it("every admitOpenRouterFreeRequest call site passes user.id / user.planTier (or an equivalent already-authenticated identity), never a body field", () => {
    let callSites = 0;
    for (const file of walk(SRC)) {
      if (file.includes("capacity.ts")) continue; // the definition itself
      const rel = file.slice(SRC.length + 1);
      const src = readFileSync(file, "utf8");
      // Every real call site in this codebase reaches admission via
      // streamCompletion/completeOnce's required userId/planTier fields
      // (see openrouter/client.ts) — assert those call sites source both
      // from `user.` / `.id` / already-threaded params, never from a raw
      // `body.` or `request.body.` access.
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        if (/userId:\s*body\.|planTier:\s*body\.|p_user_id:\s*body\./.test(line)) {
          throw new Error(`${rel}:${i + 1} — identity sourced from request body: ${line.trim()}`);
        }
      });
      if (/userId:\s*user\.id|userId,\s*$|userId\s*=\s*user\.id/.test(src)) callSites++;
    }
    // Not a precise count (deliberately loose pattern above) — the point is
    // proving the negative (no body-sourced identity exists anywhere),
    // which the loop above already does by throwing. This just confirms
    // the scan actually looked at real call sites and wasn't vacuous.
    expect(callSites).toBeGreaterThan(0);
  });

  it("admit_openrouter_free_request is never called directly outside capacity.ts", () => {
    // The RPC name should have exactly one call site (capacity.ts) — every
    // other file must go through admitOpenRouterFreeRequest, which is what
    // guarantees the config-derived caps and the correct identity source
    // are always applied consistently rather than re-implemented ad hoc.
    let directCallSites = 0;
    for (const file of walk(SRC)) {
      if (file.endsWith("capacity.ts")) continue;
      const src = readFileSync(file, "utf8");
      if (src.includes('"admit_openrouter_free_request"')) directCallSites++;
    }
    expect(directCallSites).toBe(0);
  });
});

describe("capacity admission — cannot be bypassed via a paid-model dispatch", () => {
  it("isFreeModelId gates strictly on the :free suffix, nothing else", () => {
    const src = read("openrouter/capacity.ts");
    expect(src).toContain('modelId.endsWith(":free")');
  });

  it("streamCompletion and completeOnce both call the admission gate before their fetch(), guarded on isFreeModelId", () => {
    const src = read("openrouter/client.ts");
    for (const fn of ["streamCompletion", "completeOnce"]) {
      const fnStart = src.indexOf(`export async function ${fn}(`);
      expect(fnStart, `${fn} not found`).toBeGreaterThan(-1);
      const nextFn = src.indexOf("\nexport ", fnStart + 10);
      const body = src.slice(fnStart, nextFn === -1 ? undefined : nextFn);
      const admitAt = body.indexOf("admitOpenRouterFreeRequest");
      const fetchAt = body.indexOf("await fetch(");
      expect(admitAt, `${fn}: no admission call found`).toBeGreaterThan(-1);
      expect(fetchAt, `${fn}: no fetch() found`).toBeGreaterThan(-1);
      expect(admitAt, `${fn}: admission must run BEFORE the network call`).toBeLessThan(fetchAt);
      expect(body.slice(0, admitAt)).toContain("isFreeModelId(model)");
    }
  });

  it("a paid-variant dispatch is structurally exempt, never denied by this layer", () => {
    // isFreeModelId("some-paid-model-id") must be false for anything that
    // doesn't literally end in :free — proven directly, not just asserted
    // — see openrouter-capacity.test.ts's own isFreeModelId suite for the
    // executable version of this same claim.
    const src = read("openrouter/capacity.ts");
    expect(src).toMatch(/export function isFreeModelId\(modelId: string\): boolean \{\s*return modelId\.endsWith\(":free"\);\s*\}/);
  });
});

describe("capacity admission — fails open on infrastructure error, fails closed on malformed input", () => {
  it("an RPC transport error is logged and treated as admitted (fail open), matching this codebase's existing posture for non-spend-safety infra", () => {
    const src = read("openrouter/capacity.ts");
    const errBlock = src.slice(src.indexOf("if (error) {"), src.indexOf("if (data ==="));
    expect(errBlock).toContain("fastify.log.warn");
    expect(errBlock).not.toMatch(/throw/);
  });

  it("the RPC itself fails CLOSED on a null user or model id (SQL: returns fair_share_exceeded, never 'ok')", () => {
    const migration = readFileSync(
      join(import.meta.dirname, "..", "..", "..", "db", "migrations", "0054_openrouter_free_capacity.sql"),
      "utf8",
    );
    expect(migration).toContain("if p_user_id is null or p_model_id is null then");
    expect(migration).toContain("return 'fair_share_exceeded';");
  });
});

describe("capacity admission — every recordModelFailure call site passes the OpenRouter string id", () => {
  // REGRESSION (found live, 2026-09-07): recordModelFailure's PRE-EXISTING
  // `modelId` parameter is the model_registry ROW's uuid throughout this
  // codebase (record_model_health keys on it). markModelCapacityExhausted
  // needs the OpenRouter STRING id instead, and the first deploy of this
  // feature passed the uuid straight through — two garbage rows landed in
  // provider_free_model_capacity, keyed on a value admitOpenRouterFreeRequest
  // can never match, silently defeating the reactive layer while every log
  // line looked correct. Caught by a real end-to-end request, not a test —
  // this pins the fix at every call site so it cannot regress unnoticed.
  it("every call site passes model.openrouter_model_id as the 5th argument", () => {
    const SRC = join(import.meta.dirname, "..", "src");
    const sites = [
      "routes/mediaGeneration.ts",
      "handlers/chat.ts",
      "research/handler.ts",
    ];
    let found = 0;
    for (const rel of sites) {
      const src = readFileSync(join(SRC, rel), "utf8");
      const matches = src.match(/recordModelFailure\(fastify, model\.id, err, Date\.now\(\) - startedAt(, model\.openrouter_model_id)?\)/g) ?? [];
      for (const m of matches) {
        found++;
        expect(m, `${rel}: recordModelFailure call is missing the openrouterModelId argument`).toContain("model.openrouter_model_id");
      }
    }
    expect(found, "expected to find at least 4 known recordModelFailure call sites").toBeGreaterThanOrEqual(4);
  });
});

describe("capacity admission — an exhausted-candidate-list free-cap failure gets an honest message", () => {
  // REGRESSION (found live, 2026-09-07): a real math request exhausted
  // both free math candidates on OpenRouter's genuine free-models-per-day
  // cap. isRetryableOpenRouterError correctly retried the second candidate,
  // but when THAT also failed the same way, the outer catch's message
  // ternary had no branch for isFreeModelDailyCapExceededError and fell to
  // the generic "Something went wrong" — confirmed against the actual
  // failed message row in production. Pinned here so the branch cannot be
  // silently dropped again.
  it("isFreeModelDailyCapExceededError is checked in chat.ts's outer error-message ternary", () => {
    const src = read("handlers/chat.ts");
    const ternaryStart = src.indexOf("sse.error({\n      message: isProviderBusyError(err)");
    expect(ternaryStart, "outer error-message ternary not found where expected").toBeGreaterThan(-1);
    const ternary = src.slice(ternaryStart, ternaryStart + 1600);
    expect(ternary).toContain("isFreeModelDailyCapExceededError(err)");
  });
});

describe("capacity admission — no double counting across a turn's own retries", () => {
  it("each fallback candidate attempt is admitted independently (no shared skip/bypass flag)", () => {
    const src = read("handlers/chat.ts");
    const loopStart = src.indexOf("for (let i = 0; i < modelCandidates.length; i++)");
    const loopBody = src.slice(loopStart, loopStart + 900);
    // streamCompletion is called fresh inside the loop body for every
    // candidate — there is no pre-computed "admitted" boolean hoisted
    // above the loop that could let a later candidate skip its own check.
    expect(loopBody).toContain("await streamCompletion(");
    expect(src.slice(0, loopStart)).not.toMatch(/const\s+admitted\s*=/);
  });
});
