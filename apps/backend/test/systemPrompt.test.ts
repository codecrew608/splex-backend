import { describe, it, expect } from "vitest";
import { reasoningVerificationBlock } from "../src/cortex/systemPrompt.js";

describe("reasoningVerificationBlock — domain-specific accuracy verification", () => {
  it("returns nothing for categories with no verification block (media/tool/general)", () => {
    for (const category of ["general", "writing", "documents", "vision", "image", "web_search", "deep_research"]) {
      expect(reasoningVerificationBlock(category)).toBe("");
    }
  });

  it("reasoning category covers physics sign-convention, stateful-puzzle transitions, AND concurrency-model consistency — all three, since the classifier doesn't split them further", () => {
    const block = reasoningVerificationBlock("reasoning");
    expect(block).toMatch(/coordinate system and sign convention/i);
    expect(block).toMatch(/apply exactly one transition at a time/i);
    expect(block).toMatch(/stale read producing a lost update|non-atomic read-modify-write|transaction-level race/i);
    expect(block).toMatch(/do not blend them into one trace/i);
  });

  it("math category asks for a second-pass check on important calculations, not trivial ones", () => {
    const block = reasoningVerificationBlock("math");
    expect(block).toMatch(/redo it a second way/i);
    expect(block).toMatch(/don't do this for arithmetic simple enough/i);
  });

  it("coding category distinguishes conceptual from executable correctness and asks for edge cases + invariants", () => {
    const block = reasoningVerificationBlock("coding");
    expect(block).toMatch(/conceptually right.*actually runs correctly/is);
    expect(block).toMatch(/edge cases/i);
    expect(block).toMatch(/invariant/i);
  });

  it("every non-empty block instructs the model to verify SILENTLY and never expose the check itself", () => {
    for (const category of ["reasoning", "math", "coding"]) {
      const block = reasoningVerificationBlock(category);
      expect(block).toMatch(/silently/i);
      expect(block).toMatch(/do not show your derivation/i);
      expect(block).toMatch(/never mention that you performed a verification step/i);
    }
  });
});
