import { describe, it, expect } from "vitest";
import { hasHardFormatConstraint, formatConstraintBlock } from "../src/cortex/systemPrompt.js";

/**
 * Regression suite for hard output constraints.
 *
 * SIB v1.0 measured instruction following at 66.7% (n=6) — SPLEX's only
 * genuine, repeated quality weakness. Both failures were a stated constraint
 * being quietly broken.
 *
 * What this file can and cannot prove, stated plainly: whether a model OBEYS
 * a constraint is a property of the model and needs a live run to measure
 * (bench/corpus sib-ext-if-* items, scored by the STRUCTURE scorer). What is
 * testable here — and what has to be right for the live fix to work at all —
 * is the DETECTOR: it must fire on every real constraint and stay silent on
 * ordinary prose, because a detector that misses costs the fix entirely and
 * a detector that over-fires puts constraint-policing into every prompt in
 * the product.
 *
 * The negatives are therefore as load-bearing as the positives.
 */

const MUST_DETECT: [string, string][] = [
  ["exact word count", "Describe the ocean in exactly 5 words."],
  ["exact line count", "Reply with exactly 2 lines."],
  ["exact sentence count", "Answer in exactly two sentences."],
  ["upper bound", "Summarise this in no more than 20 words."],
  ["at most", "Explain gravity in at most 12 words."],
  ["forbidden letter", "Answer without using the letter 'e'."],
  ["negative instruction", "Do not use the word 'very' anywhere."],
  ["must not contain", "Your reply must not contain any digits."],
  ["only the number", "What is 17 times 23? Reply with only the number."],
  ["only json", "Return valid JSON only, nothing else."],
  ["json object", "Return a JSON object with a single key \"answer\"."],
  ["all lowercase", "Give three colours, all lowercase."],
  ["no digits", "Write a sentence about rain that contains no digits."],
  ["starts with", "Write one sentence that starts with 'Rain'."],
  ["in exactly", "Answer in exactly one word."],
  ["respond with only", "Respond with only the English name of the language."],
];

const MUST_NOT_DETECT: [string, string][] = [
  ["plain question", "What is the capital of France?"],
  ["open request", "Write a short poem about the sea."],
  ["arithmetic", "What is 17 × 23?"],
  ["explanation", "Explain how a jet engine works."],
  ["coding task", "Write a Python function that reverses a linked list."],
  ["summarisation", "Summarise the attached document for me."],
  ["casual", "hey, can you help me plan a trip to Japan?"],
  ["incidental 'only'", "I only have an hour, what should I see in Rome?"],
  ["incidental 'exactly'", "That is exactly what I meant, thanks."],
  ["document question", "What are the key points of this report?"],
  ["media request", "Generate an image of a red bicycle on a beach."],
  ["comparison", "Which is better for a beginner, Python or Go?"],
];

describe("hard format constraint detection", () => {
  for (const [label, prompt] of MUST_DETECT) {
    it(`detects: ${label}`, () => {
      expect(hasHardFormatConstraint(prompt), prompt).toBe(true);
    });
  }

  for (const [label, prompt] of MUST_NOT_DETECT) {
    it(`stays silent: ${label}`, () => {
      expect(hasHardFormatConstraint(prompt), prompt).toBe(false);
    });
  }
});

describe("format constraint block", () => {
  it("adds nothing when no constraint is stated", () => {
    expect(formatConstraintBlock("What is the capital of France?")).toBe("");
  });

  it("adds a check when a constraint is stated", () => {
    const block = formatConstraintBlock("Reply in exactly 5 words.");
    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain("format constraint");
  });

  it("stays short — it rides on the latency budget of every constrained turn", () => {
    // A verification block is only worth its tokens if it is small. The
    // product's p50 time-to-first-token is already 5.4s.
    expect(formatConstraintBlock("Reply in exactly 5 words.").length).toBeLessThan(900);
  });

  it("never names a specific benchmark item or answer", () => {
    // Guards against the block quietly turning into a crib sheet for the
    // evaluation set, which would make the SIB instruction-following score
    // meaningless.
    const block = formatConstraintBlock("Reply in exactly 5 words.");
    for (const leak of ["ocean", "Tokyo", "sib-ext", "benchmark", "vast endless"]) {
      expect(block.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });
});
