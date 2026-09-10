import { describe, it, expect } from "vitest";
import {
  isPlanTierEligibleForOptimization,
  shouldAttemptSemanticOptimization,
  isNetBenefitPositive,
  MIN_TOKENS_FOR_SEMANTIC,
} from "../src/optimizer/decision.js";
import { validateOptimizedOutput } from "../src/optimizer/validate.js";

describe("isPlanTierEligibleForOptimization — the Pro-only product decision", () => {
  it("true only for 'pro'", () => {
    expect(isPlanTierEligibleForOptimization("pro")).toBe(true);
  });

  it("false for every other tier", () => {
    for (const tier of ["free", "starter"] as const) {
      expect(isPlanTierEligibleForOptimization(tier)).toBe(false);
    }
  });
});

describe("shouldAttemptSemanticOptimization — spec item 3: don't optimize every request", () => {
  it("a short message like 'What is 2+2?' never reaches the semantic layer", () => {
    const result = shouldAttemptSemanticOptimization("What is 2+2?", true);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("below_threshold");
  });

  it("a long, genuinely verbose message clears the threshold", () => {
    const verbose = "Can you please take a look at this and ".repeat(10) + "let me know what you think about it overall.";
    const result = shouldAttemptSemanticOptimization(verbose, true);
    expect(result.eligible).toBe(true);
    expect(result.reason).toBeNull();
  });

  it("no optimizer model available -> ineligible regardless of length", () => {
    const verbose = "x ".repeat(500);
    const result = shouldAttemptSemanticOptimization(verbose, false);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("no_optimizer_model_available");
  });

  it("the threshold constant is exported and positive — a real, checkable number, not a magic literal buried in logic", () => {
    expect(MIN_TOKENS_FOR_SEMANTIC).toBeGreaterThan(0);
  });
});

describe("isNetBenefitPositive — spec item 24's economic rule, with real numbers", () => {
  it("a meaningful reduction with positive net savings passes", () => {
    // 1000 -> 700 tokens (30% reduction), downstream saves more than optimizer costs.
    expect(isNetBenefitPositive(1000, 700, 0.02, 0.001)).toBe(true);
  });

  it("optimized text that got LONGER never passes, even if 'savings' were somehow claimed", () => {
    expect(isNetBenefitPositive(1000, 1200, 0.05, 0.001)).toBe(false);
  });

  it("a negligible reduction (<10%) fails even with technically-positive net USD", () => {
    // 1000 -> 950 = 5% reduction — below the meaningful threshold.
    expect(isNetBenefitPositive(1000, 950, 0.001, 0.0001)).toBe(false);
  });

  it("optimizer cost equal to or exceeding downstream savings fails — spec item 24's literal 'do not optimize' case", () => {
    expect(isNetBenefitPositive(1000, 600, 0.001, 0.001)).toBe(false); // equal
    expect(isNetBenefitPositive(1000, 600, 0.001, 0.002)).toBe(false); // optimizer costs more
  });

  it("zero-cost optimizer (the common Pro-tier-via-free-registry-model case) still requires a meaningful reduction", () => {
    expect(isNetBenefitPositive(1000, 600, 0.001, 0)).toBe(true);
    expect(isNetBenefitPositive(1000, 980, 0.00002, 0)).toBe(false); // 2% reduction, below threshold
  });
});

describe("validateOptimizedOutput — spec item 10, deterministic quality guard", () => {
  const baseParams = { originalText: "", preSemanticText: "", semanticOutputRaw: "", restoredFinalText: "" };

  it("passes a faithful compression with no protected content and no special requirements", () => {
    const result = validateOptimizedOutput({
      ...baseParams,
      originalText: "Can you please help me write a short poem about the ocean?",
      preSemanticText: "Can you please help me write a short poem about the ocean?",
      semanticOutputRaw: "Write a short poem about the ocean.",
      restoredFinalText: "Write a short poem about the ocean.",
    });
    expect(result.passed).toBe(true);
  });

  it("fails on empty output", () => {
    const result = validateOptimizedOutput({ ...baseParams, originalText: "Do something useful.", restoredFinalText: "   " });
    expect(result.passed).toBe(false);
    expect(result.failureReason).toMatch(/empty/);
  });

  it("fails when a protected placeholder count changed (model dropped or duplicated one)", () => {
    const result = validateOptimizedOutput({
      ...baseParams,
      preSemanticText: "See ⟦SPLEXPROTECT0⟧ and ⟦SPLEXPROTECT1⟧ for reference.",
      semanticOutputRaw: "See ⟦SPLEXPROTECT0⟧ for reference.", // dropped placeholder 1
      restoredFinalText: "See [code] for reference.",
      originalText: "reference material",
    });
    expect(result.passed).toBe(false);
    expect(result.failureReason).toMatch(/placeholder/);
  });

  it("fails when a number from the original is missing from the optimized text", () => {
    const result = validateOptimizedOutput({
      ...baseParams,
      originalText: "Deploy exactly 42 replicas by March 15.",
      restoredFinalText: "Deploy several replicas soon.",
    });
    expect(result.passed).toBe(false);
    expect(result.failureReason).toMatch(/42/);
  });

  it("passes when every number survives, even reordered", () => {
    const result = validateOptimizedOutput({
      ...baseParams,
      originalText: "We need 42 replicas ready by day 15.",
      restoredFinalText: "By day 15, provision 42 replicas.",
    });
    expect(result.passed).toBe(true);
  });

  it("fails when a stated hard format constraint is lost", () => {
    // "Reply with only JSON" is a format constraint with no accompanying
    // number — isolates this check from the numbers-preserved check above
    // (a numeric constraint like "exactly 5 words" would trip THAT check
    // first, on the digit "5", before ever reaching this one).
    const result = validateOptimizedOutput({
      ...baseParams,
      originalText: "Summarize this and reply with only JSON.",
      restoredFinalText: "Here is a summary of the document.",
    });
    expect(result.passed).toBe(false);
    expect(result.failureReason).toMatch(/format/);
  });

  it("passes when the format constraint survives compression", () => {
    const result = validateOptimizedOutput({
      ...baseParams,
      originalText: "Summarize this and reply with only JSON.",
      restoredFinalText: "Summarize this. Reply with only JSON.",
    });
    expect(result.passed).toBe(true);
  });

  it("fails when every negation/exclusion cue is lost from a message that had them", () => {
    // "never mention" (not "do not include") specifically to isolate the
    // negation check from the format-constraint check above — "do not
    // include" is ALSO a recognized hard format constraint
    // (systemPrompt.ts's own FORMAT_CONSTRAINT_PATTERNS), which would trip
    // that check first instead of the one this test targets.
    const result = validateOptimizedOutput({
      ...baseParams,
      originalText: "Summarize the report, but never mention specific dollar amounts.",
      restoredFinalText: "Summarize the report with dollar amounts included.",
    });
    expect(result.passed).toBe(false);
    expect(result.failureReason).toMatch(/negative/);
  });

  it("passes when a negation survives compression, even reworded", () => {
    const result = validateOptimizedOutput({
      ...baseParams,
      originalText: "Summarize the report, but never mention specific dollar amounts.",
      restoredFinalText: "Summarize the report without mentioning specific dollar amounts.",
    });
    expect(result.passed).toBe(true);
  });

  it("a message with no negation, no numbers, and no format constraint has nothing extra to fail on", () => {
    const result = validateOptimizedOutput({
      ...baseParams,
      originalText: "Tell me a fun fact about octopuses.",
      restoredFinalText: "Share a fun octopus fact.",
    });
    expect(result.passed).toBe(true);
  });
});
