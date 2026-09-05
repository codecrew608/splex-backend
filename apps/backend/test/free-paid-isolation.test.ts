import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (entry.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

// THE invariant: a Free user must never reach a paid model — on the happy
// path, and equally on every error, timeout, empty-pool and registry-failure
// path. A single unguarded call site anywhere voids it, so this suite works
// from an ENUMERATION of the whole tree rather than a hand-kept list: a new
// provider call added later is caught even if nobody remembers this file.

describe("every provider call site derives its model from a tier-guarded source", () => {
  // The only two sanctioned sources:
  //   selectModelCandidates() — filters variant + free_tier_allowed + a final
  //                             post-filter, so a Free request cannot receive
  //                             a paid row.
  //   resolveClassifierModel() — tier-aware, and returns NULL (never the paid
  //                             configured model) when no free model exists.
  const SANCTIONED = [
    /model:\s*\w*[Mm]odel\.openrouter_model_id/,   // from selectModelCandidates
    /model:\s*m\.openrouter_model_id/,             // ditto, inside a fallback loop
    /model:\s*classifierModel\b/,
    /model:\s*plannerModel\b/,
    /model:\s*memoryModel\b/,
  ];

  it("enumerates every completeOnce/streamCompletion call in the tree and checks its model source", () => {
    const files = walk(SRC);
    const offenders: string[] = [];
    let callSites = 0;

    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const rel = file.slice(SRC.length + 1);
      // Skip the client itself — it DEFINES these functions.
      if (rel === "openrouter/client.ts") continue;

      const lines = src.split("\n");
      lines.forEach((line, i) => {
        // Only real invocations — `await completeOnce({`, not a prose mention
        // of streamCompletion() in a comment.
        if (/^\s*(\/\/|\*)/.test(line)) return;
        if (!/\b(completeOnce|streamCompletion)\s*\(\s*\{?\s*$|\b(completeOnce|streamCompletion)\s*\(\{/.test(line)) return;
        callSites++;

        const window = lines.slice(i, i + 14).join("\n");

        // Object SHORTHAND (`model,`) is indirection: the enclosing function
        // received the id as a parameter, so the isolation guarantee lives at
        // ITS call sites. Accepted only when the file really does declare
        // `model: string` as a parameter — and those callers are pinned
        // explicitly in the next test, so indirection alone cannot satisfy
        // this suite.
        const usesShorthand = /^\s*model,\s*$/m.test(window);
        if (usesShorthand && /model:\s*string/.test(src)) return;

        const modelLine = window.match(/model:\s*[^,\n]+/)?.[0];
        if (!modelLine) {
          offenders.push(`${rel}:${i + 1} — no model: found near call`);
          return;
        }

        if (!SANCTIONED.some((re) => re.test(modelLine))) {
          offenders.push(`${rel}:${i + 1} — unsanctioned model source: ${modelLine.trim()}`);
        }
      });
    }

    expect(callSites, "expected to find the known provider call sites").toBeGreaterThanOrEqual(6);
    expect(offenders, `unguarded provider call site(s):\n${offenders.join("\n")}`).toEqual([]);
  });

  it("functions that take a model id as a PARAMETER are fed guarded values", () => {
    // planDeck(fastify, model: string, ...) and performWebSearch(fastify,
    // model: string, ...) both take the id as a parameter, so the isolation
    // guarantee moves to their callers. Pin those here — otherwise the
    // enumeration above could be satisfied by indirection alone.
    expect(read("ppt/generate.ts"))
      .toContain("planDeck(fastify, model.openrouter_model_id, prompt)");
    expect(read("research/handler.ts"))
      .toContain("performWebSearch(fastify, model.openrouter_model_id, query)");
    // ...and those `model` values come from the guarded selector.
    expect(read("research/handler.ts")).toContain("selectModelCandidates(fastify, \"web_search\", user.planTier");
    expect(read("ppt/generate.ts")).toMatch(/model:\s*ModelRegistryRow/);
  });

  it("no call site inlines the PAID configured model", () => {
    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length + 1);
      if (rel === "cortex/classifierModel.ts") continue; // the one legitimate paid branch
      const src = readFileSync(file, "utf8");
      expect(src, `${rel} must not reference the configured paid classifier`)
        .not.toMatch(/model:\s*fastify\.config\.CORTEX_CLASSIFIER_MODEL_ID/);
    }
  });

  // completeOnceWithFallback (openrouter/client.ts) takes a whole CANDIDATE
  // LIST rather than a single `model:` field, so it structurally cannot
  // match the enumeration test's model: field regex above — a genuine blind
  // spot for the "every provider call site derives its model from a
  // tier-guarded source" invariant this whole file exists to enforce.
  // Closed here with the same two-part shape the rest of this file already
  // uses for indirection (pin the known callers' exact call shape, then a
  // whole-tree sweep so an UNDOCUMENTED new caller can't silently satisfy
  // this suite by never being checked at all).
  it("completeOnceWithFallback's candidate list always comes from the tier-guarded resolver", () => {
    const KNOWN_CALLERS = [
      ["cortex/classify.ts", "classifierCandidates"],
      ["cortex/workflow/plan.ts", "plannerCandidates"],
      ["memory/extractMemory.ts", "memoryModelCandidates"],
      ["cortex/followUpSuggestions.ts", "candidates"],
    ] as const;

    for (const [file, varName] of KNOWN_CALLERS) {
      const src = read(file);
      expect(src, `${file} must declare ${varName} from the tier-guarded resolver`).toContain(
        `const ${varName} = await resolveClassifierModelCandidates(fastify, planTier);`,
      );
      expect(src, `${file} must pass ${varName} straight into completeOnceWithFallback`).toContain(
        `completeOnceWithFallback(fastify, ${varName}, {`,
      );
    }

    const actualCallers = walk(SRC)
      .map((file) => file.slice(SRC.length + 1))
      .filter((rel) => rel !== "openrouter/client.ts" && /completeOnceWithFallback\(/.test(read(rel)));
    expect(
      actualCallers.sort(),
      "a new completeOnceWithFallback call site appeared that isn't pinned above — add it to KNOWN_CALLERS with an explicit tier-safety check, don't just let this test pass around it",
    ).toEqual(KNOWN_CALLERS.map(([file]) => file).slice().sort());
  });
});

describe("resolveClassifierModel: the paid model is unreachable for Free", () => {
  const src = read("cortex/classifierModel.ts");

  it("returns the paid model ONLY inside the non-free branch", () => {
    const guardAt = src.indexOf('if (planTier !== "free")');
    const paidAt = src.indexOf("return fastify.config.CORTEX_CLASSIFIER_MODEL_ID;");
    expect(guardAt).toBeGreaterThan(-1);
    expect(paidAt).toBeGreaterThan(guardAt);
    expect(paidAt - guardAt).toBeLessThan(80); // immediately inside the guard
    expect((src.match(/return fastify\.config\.CORTEX_CLASSIFIER_MODEL_ID;/g) ?? []).length).toBe(1);
  });

  it("a registry ERROR yields null, not the paid model", () => {
    // The exact regression: a transient model_registry failure used to put a
    // Free request on paid inference. The error branch must return null.
    const errBranch = src.slice(src.indexOf("if (error || !data?.openrouter_model_id)"));
    expect(errBranch).toContain("return null;");
    expect(errBranch.slice(0, errBranch.indexOf("return null;")))
      .not.toContain("CORTEX_CLASSIFIER_MODEL_ID");
  });

  it("the free lookup is constrained on all three registry columns", () => {
    expect(src).toContain('.eq("variant", "free")');
    expect(src).toContain('.eq("is_active", true)');
    expect(src).toContain('.eq("free_tier_allowed", true)');
  });
});

describe("empty / failed candidate pools degrade cleanly rather than escalating", () => {
  it("classification skips the call instead of spending", () => {
    expect(read("cortex/classify.ts")).toContain('throw new Error("no free classifier model available")');
  });

  it("workflow planning falls back to single-shot chat", () => {
    const src = read("cortex/workflow/plan.ts");
    expect(src).toContain("if (plannerCandidates.length === 0)");
    expect(src).toContain('return { outcome: "fallback" };');
  });

  it("memory extraction is simply skipped", () => {
    expect(read("memory/extractMemory.ts")).toContain("if (memoryModelCandidates.length === 0) return;");
  });

  it("zero candidates produces a refusal, never a cross-variant borrow", () => {
    const src = read("cortex/modelSelect.ts");
    expect(src).toContain("if (pool.length === 0) return [];");
    // the general fallback re-queries with the SAME variant
    expect(src).toContain('queryModelRegistry(fastify, "general", variant, planTier)');
  });

  it("media categories cannot borrow the general text pool", () => {
    const src = read("cortex/modelSelect.ts");
    expect(src).toContain('NO_GENERAL_FALLBACK = new Set(["image", "audio", "video", "ppt"])');
  });

  it("a final post-filter drops any non-free row that somehow survived", () => {
    const src = read("cortex/modelSelect.ts");
    expect(src).toContain('planTier === "free"');
    expect(src).toContain('s.model.variant === "free"');
    expect(src).toContain("cost-safety guard");
  });
});

describe("provider failure paths never escalate to a paid model", () => {
  it("the chat fallback loop stays within the candidate list it was given", () => {
    const src = read("handlers/chat.ts");
    // Iterates the SAME array selectModelCandidates returned — there is no
    // path that widens the pool or re-queries with a different variant.
    expect(src).toContain("for (let i = 0; i < modelCandidates.length; i++)");
    expect(src).toContain("model = modelCandidates[i];");
    expect(src).not.toMatch(/variant:\s*["']paid["']/);
  });

  it("429 and 403 continue the chain; neither reaches for a paid model", () => {
    const src = read("openrouter/client.ts");
    expect(src).toMatch(/\(429\|5\\d\\d\)/);
    expect(src).toContain("isModelAccessDeniedError(err)");
    expect(src).not.toMatch(/CORTEX_CLASSIFIER_MODEL_ID/);
  });

  it("402 (balance exceeded) is NOT retryable — retrying cannot help and would only spend more", () => {
    const src = read("openrouter/client.ts");
    const fn = src.slice(src.indexOf("export function isBalanceExceededError"));
    expect(fn).toContain("402");
  });
});
