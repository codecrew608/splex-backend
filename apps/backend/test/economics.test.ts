import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { computeRealCost, DEFAULT_CREDITS_PER_USD } from "../src/credits/realCost.js";
import { computeMediaCreditsCharged } from "../src/credits/mediaCost.js";
import type { ModelRegistryRow } from "../src/types/index.js";

const SRC = join(import.meta.dirname, "..", "src");
const ROOT = join(SRC, "..", "..", "..");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (e.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

// Prices from migration 0032, which took them from OpenRouter's own
// /api/v1/models metadata rather than from memory.
const FLASH: ModelRegistryRow = {
  id: "m-flash", category: "general", openrouter_model_id: "deepseek/deepseek-v4-flash-0731",
  variant: "paid", capability_score: 78, context_length: 1310720,
  cost_per_million_input: 0.045, cost_per_million_output: 0.09,
  is_active: true, priority: 20,
};
const GLM: ModelRegistryRow = {
  ...FLASH, id: "m-glm", openrouter_model_id: "z-ai/glm-5.2",
  cost_per_million_input: 1.19, cost_per_million_output: 3.74, priority: 10, capability_score: 90,
};

function fastify(creditsPerUsd?: number) {
  return {
    config: creditsPerUsd === undefined ? {} : { CREDITS_PER_USD: creditsPerUsd },
    log: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
    supabaseAdmin: { from: () => ({ select: function () { return this; }, eq: function () { return this; },
      order: function () { return this; }, limit: function () { return this; },
      maybeSingle: async () => ({ data: null, error: null }) }) },
  } as never;
}

describe("there is exactly ONE credit conversion rate", () => {
  it("mediaCost imports the rate rather than declaring its own", () => {
    const media = read("credits/mediaCost.ts");
    expect(media).toContain('import { DEFAULT_CREDITS_PER_USD } from "./realCost.js"');
    // The regression this prevents: media used to declare 25_000 while text
    // used 20_000, so identical spend was billed 25% differently by capability.
    expect(media).not.toMatch(/const DEFAULT_CREDITS_PER_USD\s*=\s*\d/);
  });

  it("no other file declares a competing rate", () => {
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      const rel = f.slice(SRC.length + 1);
      if (rel === "credits/realCost.ts") continue;
      if (/(const|let)\s+\w*CREDITS_PER_USD\w*\s*=\s*[\d_]+/.test(readFileSync(f, "utf8"))) {
        offenders.push(rel);
      }
    }
    expect(offenders, `duplicate credit rate in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("text and media agree on the rate for the same USD spend", async () => {
    const f = fastify();
    const media = computeMediaCreditsCharged(f, 0.01);
    // Same $0.01 expressed as tokens on a known-price model.
    const text = await computeRealCost(f, "general", FLASH, {
      prompt_tokens: 0, completion_tokens: Math.round((0.01 / 0.09) * 1_000_000), total_tokens: 0,
    });
    expect(Math.abs(media - text.creditsCharged)).toBeLessThanOrEqual(1);
  });

  it("every env schema and deploy var uses the same default", () => {
    for (const p of ["plugins/env.ts", "worker/env.ts"]) {
      expect(read(p), p).toContain("CREDITS_PER_USD: z.coerce.number().positive().default(120_000)");
    }
    const bundle = readFileSync(join(ROOT, "scripts/bundle-backend.sh"), "utf8");
    expect(bundle).not.toMatch(/CREDITS_PER_USD[=":\s]+(20000|25000)\b/);
    expect(DEFAULT_CREDITS_PER_USD).toBe(120_000);
  });
});

describe("charging scales with real computational cost, not prompt length", () => {
  const usage = (i: number, o: number) => ({ prompt_tokens: i, completion_tokens: o, total_tokens: i + o });

  it("a pricier model costs more for identical token counts", async () => {
    const f = fastify();
    const cheap = await computeRealCost(f, "general", FLASH, usage(1500, 700));
    const dear = await computeRealCost(f, "general", GLM, usage(1500, 700));
    expect(dear.creditsCharged).toBeGreaterThan(cheap.creditsCharged * 10);
  });

  it("more work on the SAME model costs proportionally more", async () => {
    const f = fastify();
    const small = await computeRealCost(f, "general", GLM, usage(500, 200));
    const large = await computeRealCost(f, "general", GLM, usage(5000, 3000));
    expect(large.creditsCharged).toBeGreaterThan(small.creditsCharged * 5);
  });

  it("a SHORT prompt with a long generation is not cheap", async () => {
    // Directly encodes the spec's rule that length != cost: 20 input tokens
    // with a large completion must cost more than a huge prompt with a
    // one-word answer.
    const f = fastify();
    const shortPromptBigAnswer = await computeRealCost(f, "general", GLM, usage(20, 4000));
    const longPromptTinyAnswer = await computeRealCost(f, "general", GLM, usage(4000, 20));
    expect(shortPromptBigAnswer.creditsCharged).toBeGreaterThan(longPromptTinyAnswer.creditsCharged);
  });

  it("the floor is 1 credit — nothing is ever free", async () => {
    const f = fastify();
    const r = await computeRealCost(f, "general", FLASH, usage(1, 1));
    expect(r.creditsCharged).toBeGreaterThanOrEqual(1);
  });

  it("a realistic paid day sits inside the 3,300 daily cap", async () => {
    // 20 simple + 5 medium + 1 complex/reasoning. Priced using the model
    // each tier would ACTUALLY route to, not an arbitrary stand-in:
    // resolveRoutingProfile sends general chat at simple/medium complexity
    // through 'cheap_fast' (cost-dominant -> Flash wins there, verified in
    // routing-economics.test.ts), and only complexity='complex' or
    // category='reasoning'/'math' reaches 'deep_quality' (where GLM, the
    // spec's primary, wins). Pricing "medium" at GLM would silently assume
    // every ordinary chat gets the premium model, which is exactly the
    // "always the strongest, never economical" failure mode the spec rules
    // out — and it produced a false failure here (4,254 over cap) before
    // this fix, from a scenario the real router would never produce.
    const f = fastify();
    const simple = (await computeRealCost(f, "general", FLASH, usage(600, 300))).creditsCharged;
    const medium = (await computeRealCost(f, "general", FLASH, usage(1500, 700))).creditsCharged;
    const complex = (await computeRealCost(f, "reasoning", GLM, usage(4000, 2000))).creditsCharged;
    const day = 20 * simple + 5 * medium + 1 * complex;
    expect(day).toBeLessThan(3300);
    // ...and not so cheap that the cap is meaningless.
    expect(day).toBeGreaterThan(500);
  });

  it("a heavy day genuinely exhausts the cap (the cap has teeth)", async () => {
    const f = fastify();
    const complex = (await computeRealCost(f, "reasoning", GLM, usage(8000, 4000))).creditsCharged;
    expect(complex * 3).toBeGreaterThan(3300);
  });
});

describe("Free-tier shadow pricing stays viable", () => {
  it("prices against the CHEAPEST paid row, not the highest-priority one", () => {
    const src = read("credits/realCost.ts");
    expect(src).toContain('.order("cost_per_million_output", { ascending: true })');
    expect(src).not.toMatch(/\.eq\("variant", "paid"\)[\s\S]{0,200}\.order\("priority"/);
  });

  it("an ordinary Free chat costs far less than the 500/day Free cap", async () => {
    // With priority ordering this was ~528 credits against a 500 cap — one
    // message would have exhausted a Free user's entire day.
    const f = fastify();
    const r = await computeRealCost(f, "general", { ...FLASH, variant: "free" }, {
      prompt_tokens: 1500, completion_tokens: 700, total_tokens: 2200,
    });
    // No paid row resolvable in this fake, so the nominal fallback applies —
    // the point is the magnitude stays far below a day's allowance.
    expect(r.creditsCharged).toBeLessThan(100);
  });
});

describe("plan limits live in plan_limits only", () => {
  it("no credit limit is hardcoded in backend source", () => {
    for (const f of walk(SRC)) {
      const src = readFileSync(f, "utf8");
      const rel = f.slice(SRC.length + 1);
      // The new entitlement numbers must not appear as literals anywhere —
      // plan_limits is the single source of truth (spec §26).
      expect(src, `${rel} hardcodes a plan limit`).not.toMatch(/\b(100000|15000|3300|500)\s*;?\s*\/\/\s*(monthly|daily)/i);
    }
  });

  it("the frontend reads limits live rather than restating them", () => {
    const page = readFileSync(join(ROOT, "apps/web/app/(app)/upgrade/page.tsx"), "utf8");
    expect(page).toContain("plan_limits");
    expect(page).toMatch(/read live from plan_limits rather than hardcoded/i);
  });
});

describe("migration 0032 is internally consistent", () => {
  const sql = readFileSync(join(ROOT, "db/migrations/0032_paid_economics_and_model_pool.sql"), "utf8");

  it("sets exactly the specified entitlements", () => {
    expect(sql).toMatch(/limit_amount = 15000[\s\S]{0,120}'free'[\s\S]{0,40}'credits'/);
    expect(sql).toMatch(/limit_amount = 500[\s\S]{0,120}'free'[\s\S]{0,40}'daily_credits'/);
    expect(sql).toMatch(/limit_amount = 100000[\s\S]{0,120}'pro'[\s\S]{0,40}'credits'/);
    expect(sql).toMatch(/limit_amount = 3300[\s\S]{0,120}'pro'[\s\S]{0,40}'daily_credits'/);
  });

  it("inserts every approved paid model and no others", () => {
    for (const m of ["z-ai/glm-5.2", "nvidia/nemotron-3-ultra-550b-a55b", "minimax/minimax-m3"]) {
      expect(sql, `${m} must join the paid pool`).toContain(`'${m}','paid'`);
    }
    // Every inserted paid row must be barred from the Free tier.
    const inserts = sql.match(/'paid',true,(true|false),/g) ?? [];
    expect(inserts.length).toBeGreaterThan(0);
    for (const i of inserts) expect(i, "a paid row must not be free_tier_allowed").toContain("'paid',true,false,");
  });

  it("ends by forcing free_tier_allowed=false on every paid row", () => {
    expect(sql).toContain("update public.model_registry set free_tier_allowed = false where variant = 'paid'");
  });

  it("keeps media capabilities rather than deleting product features", () => {
    expect(sql).toContain("and category not in ('image', 'audio', 'video', 'ppt')");
  });

  it("deactivates rather than deletes retired models", () => {
    expect(sql).not.toMatch(/delete\s+from\s+public\.model_registry/i);
  });
});
