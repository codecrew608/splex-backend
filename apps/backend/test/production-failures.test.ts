import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenRouterError, describeError, isRetryableOpenRouterError } from "../src/openrouter/client.js";
import { IntelligenceNotConfiguredError, isIntelligenceConfigured } from "../src/intelligence/client.js";

const SRC = join(import.meta.dirname, "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

// Each block below maps to a distinct failure visible in production
// `wrangler tail` output.

describe("BUG: production logs showed `err: {}` for every model failure", () => {
  it("OpenRouterError carries status, body and model as ENUMERABLE fields", () => {
    const e = new OpenRouterError("stream", 429, "rate limit exceeded for :free pool", "z-ai/glm-5.2:free");
    // The whole point: a plain JSON serializer must see the detail. An
    // ordinary Error yields "{}" because name/message/stack are
    // non-enumerable, which is exactly what made these undiagnosable.
    const serialized = JSON.parse(JSON.stringify({ ...describeError(e) }));
    expect(serialized.status).toBe(429);
    expect(serialized.providerBody).toContain("rate limit");
    expect(serialized.model).toBe("z-ai/glm-5.2:free");
    expect(Object.keys(serialized).length).toBeGreaterThan(3);
  });

  it("a bare Error still serializes to something useful, never {}", () => {
    const out = JSON.parse(JSON.stringify(describeError(new Error("boom"))));
    expect(out.errorMessage).toBe("boom");
    expect(Object.keys(out)).not.toHaveLength(0);
  });

  it("preserves the exact message shape the classifiers regex", () => {
    // isRetryableOpenRouterError et al. match on this string; changing the
    // format would silently break fallback.
    const e = new OpenRouterError("stream", 404, "No endpoints found for x", "x");
    expect(e.message).toMatch(/^OpenRouter request failed \(404\)/);
    expect(isRetryableOpenRouterError(e)).toBe(true);
    expect(describeError(e).modelUnavailable).toBe(true);

    const c = new OpenRouterError("classifier", 429, "slow down", null);
    expect(c.message).toMatch(/^OpenRouter classifier request failed \(429\)/);
  });

  it("every model-failure log site uses describeError", () => {
    for (const f of ["handlers/chat.ts", "routes/mediaGeneration.ts", "research/handler.ts", "memory/extractMemory.ts"]) {
      expect(read(f), `${f} must not log a raw error object`).toContain("describeError");
    }
    // and none of them still log the bare `{ err }`
    for (const f of ["routes/mediaGeneration.ts", "research/handler.ts"]) {
      expect(read(f)).not.toMatch(/log\.warn\(\{ err,/);
    }
  });
});

describe("BUG: image generation dispatched TEXT models (capability-crossing fallback)", () => {
  it("media categories never fall back to the general text pool", () => {
    const src = read("cortex/modelSelect.ts");
    expect(src).toContain('NO_GENERAL_FALLBACK = new Set(["image", "audio", "video", "ppt"])');
    expect(src).toContain("pool.length === 0 && canFallBackToGeneral(category)");
  });

  it("text categories DO still fall back (the useful half is preserved)", () => {
    const src = read("cortex/modelSelect.ts");
    // guard is a denylist, so anything not listed keeps the old behaviour
    for (const c of ["math", "coding", "writing", "reasoning", "vision", "documents"]) {
      expect(src).not.toContain(`"${c}"`.padStart(0) + ", // no-fallback");
    }
    expect(src).toMatch(/function canFallBackToGeneral\(category: string\): boolean \{\s*return !NO_GENERAL_FALLBACK\.has\(category\);/);
  });

  it("the variant filter is applied to the general fallback too (no paid leak)", () => {
    const src = read("cortex/modelSelect.ts");
    expect(src).toContain('queryModelRegistry(fastify, "general", variant, planTier)');
  });
});

describe("BUG: Free users triggered PAID provider calls", () => {
  it("internal classification is tier-aware", () => {
    const src = read("cortex/classifierModel.ts");
    expect(src).toContain('if (planTier !== "free")');
    expect(src).toContain('.eq("variant", "free")');
    expect(src).toContain('.eq("is_active", true)');
    expect(src).toContain('.eq("free_tier_allowed", true)');
  });

  it("no internal call site uses the configured model unconditionally", () => {
    for (const f of ["cortex/classify.ts", "memory/extractMemory.ts"]) {
      const src = read(f);
      expect(src).toContain("resolveClassifierModel(fastify, planTier)");
      expect(src, `${f} must not hardcode the configured (paid) model`).not.toMatch(
        /model: fastify\.config\.CORTEX_CLASSIFIER_MODEL_ID/,
      );
    }
  });

  it("falls back loudly, not silently, if no free model exists", () => {
    const src = read("cortex/classifierModel.ts");
    expect(src).toContain("fastify.log.error");
    expect(src).toMatch(/falling back to the configured \(paid\) model/);
  });
});

describe("BUG: OCR / RAG failures were really a missing deployment", () => {
  const fake = (url?: string) => ({ config: { INTELLIGENCE_SERVICE_URL: url } }) as never;

  it("detects an unconfigured intelligence service", () => {
    expect(isIntelligenceConfigured(fake(undefined))).toBe(false);
    expect(isIntelligenceConfigured(fake(""))).toBe(false);
    expect(isIntelligenceConfigured(fake("https://intel.example.com"))).toBe(true);
  });

  it("throws a typed error instead of fetching the string 'undefined/ocr/image'", () => {
    const e = new IntelligenceNotConfiguredError("OCR (/ocr/image)");
    expect(e.name).toBe("IntelligenceNotConfiguredError");
    expect(e.message).toContain("INTELLIGENCE_SERVICE_URL unset");
  });

  it("guards every sidecar entry point before building a URL", () => {
    const src = read("intelligence/client.ts");
    expect((src.match(/if \(!isIntelligenceConfigured\(fastify\)\) throw new IntelligenceNotConfiguredError/g) ?? []).length).toBe(2);
  });

  it("call sites distinguish not-configured from a genuine fault", () => {
    const files = read("handlers/files.ts");
    expect(files).toContain("err instanceof IntelligenceNotConfiguredError");
    expect(files).toContain("failed against a configured service"); // real faults are log.error
    const retrieve = read("intelligence/retrieve.ts");
    expect(retrieve).toContain("if (!isIntelligenceConfigured(fastify)) return null;");
    expect(retrieve).toContain("failed against a configured service");
  });
});

describe("credit safety across every provider outcome", () => {
  it("sync media reserves, defaults the charge to 0, and settles in finally", () => {
    const src = read("routes/mediaGeneration.ts");
    const reserveAt = src.indexOf("checkAndReserveCredits(fastify, user.id, gateEstimate)");
    const zeroAt = src.indexOf("let dailyActualCost = 0;");
    const candidatesAt = src.indexOf("selectModelCandidates(fastify, kind");
    // Ordering is the guarantee: nothing can be charged before a successful
    // generation sets dailyActualCost, and `finally` releases on every path.
    expect(reserveAt).toBeGreaterThan(-1);
    expect(zeroAt).toBeGreaterThan(reserveAt);
    expect(candidatesAt).toBeGreaterThan(zeroAt);
    expect(src).toContain("settleDailyReservation(fastify, user.id, gate.dailyReserved, dailyActualCost)");
  });

  it("zero candidates cannot charge — the actual cost is still 0 at that exit", () => {
    const src = read("routes/mediaGeneration.ts");
    const zeroAt = src.indexOf("let dailyActualCost = 0;");
    const setAt = src.indexOf("dailyActualCost = creditsCharged;");
    const noCandidates = src.indexOf("candidates.length === 0");
    expect(noCandidates).toBeGreaterThan(zeroAt);
    expect(noCandidates).toBeLessThan(setAt); // the early return happens before any charge is set
  });
});

describe("PROVIDER COST: no Free request can reach a paid model", () => {
  const walk = (dir: string): string[] => {
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    return readdirSync(dir).flatMap((e: string) => {
      const full = join(dir, e);
      return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
    });
  };
  const files = walk(SRC);

  it("NO module uses the configured (paid) classifier model directly", () => {
    const offenders = files.filter((f) => {
      if (f.includes("classifierModel.ts") || f.includes("env.ts")) return false; // resolver + schema
      return readFileSync(f, "utf8").includes("config.CORTEX_CLASSIFIER_MODEL_ID");
    });
    expect(offenders, `these bypass tier isolation: ${offenders.join(", ")}`).toEqual([]);
  });

  it("all three internal call sites resolve the model by tier", () => {
    for (const f of ["cortex/classify.ts", "cortex/workflow/plan.ts", "memory/extractMemory.ts"]) {
      expect(read(f), `${f} must be tier-aware`).toContain("resolveClassifierModel(fastify, planTier)");
    }
  });

  it("candidate selection filters by variant and re-guards the final list", () => {
    const src = read("cortex/modelSelect.ts");
    expect(src).toContain('.eq("variant", variant)');
    expect(src).toContain('planTier === "free"');
    expect(src).toContain('s.model.variant === "free"'); // redundant cost-safety guard
  });
});
