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

  it("math category's verification also covers algebraic-transformation validity, inequality-direction flips, and unit consistency", () => {
    const block = reasoningVerificationBlock("math");
    expect(block).toMatch(/each algebraic transformation you perform is actually valid/i);
    expect(block).toMatch(/multiplying or dividing an inequality by a negative value, its direction must flip/i);
    expect(block).toMatch(/carry them through the calculation/i);
    expect(block).toMatch(/confirm it actually satisfies the original stated conditions/i);
  });

  it("math AND reasoning categories both get math-notation guidance (physics/vectors live under 'reasoning', not 'math')", () => {
    for (const category of ["math", "reasoning"]) {
      const block = reasoningVerificationBlock(category);
      expect(block).toMatch(/standard mathematical notation instead of describing calculations in prose/i);
      // $$...$$ for BOTH inline and display -- matching MarkdownRenderer.tsx's
      // singleDollarTextMath:false, which turns single-$ math off entirely
      // (it collides with ordinary text mentioning a price/amount). The
      // prompt must never tell the model to use a bare single $, since the
      // renderer won't treat it as math at all.
      expect(block).toMatch(/\$\$\.\.\.\$\$/);
      expect(block).toMatch(/never a single \$/);
    }
  });

  it("math-notation guidance is explicitly NOT silent — it says so, distinguishing it from the verification pass above it", () => {
    const block = reasoningVerificationBlock("math");
    expect(block).toMatch(/show the actual solving steps as your answer/i);
    expect(block).toMatch(/distinct from the silent verification pass described above/i);
  });

  it("math-notation guidance tells the model not to force LaTeX onto ordinary prose or pad trivial calculations", () => {
    const block = reasoningVerificationBlock("math");
    expect(block).toMatch(/don't pad a one-line calculation into an unnecessary multi-step derivation/i);
    expect(block).toMatch(/don't force LaTeX onto ordinary prose/i);
  });

  it("coding category does NOT get math-notation guidance (it's not a math category)", () => {
    const block = reasoningVerificationBlock("coding");
    expect(block).not.toMatch(/\$\.\.\.\$/);
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
