import { describe, it, expect } from "vitest";
import { reasoningVerificationBlock, buildSystemPrompt } from "../src/cortex/systemPrompt.js";

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
      expect(block).toMatch(/plain, readable text by default/i);
    }
  });

  // REGRESSION — real user sessions, 2026-09-07. The guidance previously
  // told the model to use $$...$$ for all maths, matching
  // MarkdownRenderer.tsx's singleDollarTextMath:false. The models did not
  // comply: they emitted $...$, \(...\), [ 3x = 9 ] and \boxed{x = 3},
  // none of which that renderer accepts — so users saw raw markup like
  // \frac{20 - 9x}{2} on answers that were otherwise correct, on trivial
  // algebra that never needed rendering in the first place.
  //
  // The durable lesson, and what these assertions actually protect: a
  // precise delimiter contract is not something weaker open-weight models
  // reliably honour, so the safe default for ordinary maths is notation
  // that needs no rendering at all. $$...$$ survives only as the narrow
  // exception for notation plain text genuinely cannot express.
  it("defaults to PLAIN TEXT maths and explicitly forbids the markup users were seeing raw", () => {
    const block = reasoningVerificationBlock("math");
    expect(block).toMatch(/plain, readable text by default/i);
    // Names the exact artefacts observed leaking to real users.
    expect(block).toMatch(/\\frac/);
    expect(block).toMatch(/\\boxed/);
    expect(block).toMatch(/NEVER emit backslash commands/i);
  });

  it("keeps $$...$$ as the narrow exception, and still never permits a bare single $", () => {
    const block = reasoningVerificationBlock("math");
    expect(block).toMatch(/\$\$\.\.\.\$\$/);
    expect(block).toMatch(/never a single \$/);
    // The exception must read as an exception, not a general permission.
    expect(block).toMatch(/only.{0,40}exception|exception.{0,80}genuinely complex/i);
  });

  it("math-notation guidance is explicitly NOT silent — the worked steps are the answer", () => {
    const block = reasoningVerificationBlock("math");
    expect(block).toMatch(/show the actual solving steps/i);
    expect(block).toMatch(/state the final result plainly/i);
  });

  it("still tells the model not to pad a trivial calculation into a fake derivation", () => {
    const block = reasoningVerificationBlock("math");
    expect(block).toMatch(/don't pad a one-line calculation into an unnecessary multi-step derivation/i);
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

// REGRESSION — reported with a screenshot, 2026-09-07, AFTER a first fix
// that did not hold. The plain-text-maths rule was originally added only to
// MATH_NOTATION_GUIDANCE, which reasoningVerificationBlock appends for the
// "math" and "reasoning" categories only. But a simple question like
// "what is x if 3x=9" carries no math strong-keyword (no operator between
// digits, no "solve for"/"calculate"/"equation"), so Cortex routes it to
// "general" — where that block returns "" and the rule was never applied.
// The user's screenshot showed exactly that: routing panel reading "Best
// fit for a fast response" (the general/chat v1 label) above an answer
// rendered as the literal text "$x = 3$".
//
// The lesson: this is an output-FORMATTING rule, not a maths-domain rule.
// Formatting applies to every answer whatever the routing decision, so it
// belongs in the persona — which is what these assertions pin.
describe("plain-text maths is a GLOBAL persona rule, not a math-category one", () => {
  it("the base system prompt forbids LaTeX markup, with no category needed", () => {
    const prompt = buildSystemPrompt(null);
    expect(prompt).toMatch(/plain, readable text — never LaTeX markup/i);
    expect(prompt).toMatch(/\\frac/);
    expect(prompt).toMatch(/\\boxed/);
    expect(prompt).toMatch(/applies to EVERY answer/i);
  });

  it("the rule survives every optional-block combination the builder supports", () => {
    for (const prompt of [
      buildSystemPrompt(null),
      buildSystemPrompt("remembers things"),
      buildSystemPrompt(null, "file context"),
      buildSystemPrompt("mem", "file", "Project X", "project mem"),
    ]) {
      expect(prompt).toMatch(/never LaTeX markup/i);
    }
  });

  it("a general-category turn — the exact routing that leaked to the user — still carries the rule", () => {
    // reasoningVerificationBlock contributes nothing for "general"; the
    // persona is what has to carry it, and does.
    expect(reasoningVerificationBlock("general")).toBe("");
    expect(buildSystemPrompt(null) + reasoningVerificationBlock("general")).toMatch(/never LaTeX markup/i);
  });
});
