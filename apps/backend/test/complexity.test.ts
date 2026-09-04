import { describe, it, expect } from "vitest";
import { estimateComplexity } from "../src/cortex/complexity.js";

// FIX (user-reported, 2026-09-04): a genuinely long free-tier prompt could
// get misclassified as "simple" — and therefore routed to the
// fastest/cheapest model regardless of its actual substance — if it
// happened to contain an incidental SIMPLE_HINTS word ("quickly", "just",
// "briefly", "short", "one-liner") anywhere in it. estimateComplexity now
// floors a long-enough message at "medium" no matter what else drags its
// score down.
describe("estimateComplexity — long-prompt floor", () => {
  const LONG_NEUTRAL_TEXT = "word ".repeat(130).trim(); // >120 words, no hint words at all

  it("a long, hint-free message classifies as at least medium (length bonus alone)", () => {
    expect(estimateComplexity(LONG_NEUTRAL_TEXT)).not.toBe("simple");
  });

  it("a long message containing an incidental SIMPLE_HINTS word no longer collapses to simple", () => {
    // Exactly the reported scenario: length signal (+2) previously
    // cancelled out by "quickly" (-2) landing back at a net score of 0.
    const message = `Can you quickly walk me through this — ${LONG_NEUTRAL_TEXT}`;
    expect(estimateComplexity(message)).not.toBe("simple");
  });

  it("a long message with a genuine COMPLEX_HINTS match still classifies as complex, not just medium", () => {
    const message = `Give me a comprehensive, in depth breakdown — ${LONG_NEUTRAL_TEXT}`;
    expect(estimateComplexity(message)).toBe("complex");
  });

  it("a SHORT message with a SIMPLE_HINTS word still classifies as simple — the floor only applies to long messages", () => {
    expect(estimateComplexity("just fix this typo quickly")).toBe("simple");
  });

  it("a short, hint-free, low-signal message still classifies as simple", () => {
    expect(estimateComplexity("what's 2+2")).toBe("simple");
  });

  it("a mid-length message (41-120 words) alone already scores medium on its own merits — pre-existing behavior, unaffected by the new floor", () => {
    // The floor branch only ever runs when score <= 0; a message in this
    // range scores +1 from length alone, which is already > 0, so the
    // floor logic is never even reached here.
    const midLength = "word ".repeat(60).trim(); // >40, <=120 words
    expect(estimateComplexity(midLength)).toBe("medium");
  });
});
