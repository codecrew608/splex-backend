import type { ComplexityLevel } from "@splex/shared-types";

const SIMPLE_HINTS = [/\bquick(ly)?\b/i, /\bjust\b/i, /\bbriefly\b/i, /\bshort\b/i, /\bone[- ]liner\b/i];
const COMPLEX_HINTS = [
  /\bstep by step\b/i,
  /\bentire (project|app|codebase)\b/i,
  /\barchitecture\b/i,
  /\bin depth\b/i,
  /\bcomprehensive\b/i,
  /\bmulti[- ]?file\b/i,
  /\bend[- ]to[- ]end\b/i,
];

// Lives here (not workflow/trigger.ts, which imports it) because
// estimateComplexity now depends on it directly — see the isOutcomeShaped
// comment below for why. Deliberately conservative and NOT an LLM call —
// same regex-hint-scoring pattern as the rest of this file.
export const OUTCOME_HINTS = [
  /\bbuild (me|us|a|an)\b/i,
  /\bcreate a complete\b/i,
  /\bdevelop (a|an|the)\b/i,
  /\bset up a full\b/i,
  /\bgenerate a complete\b/i,
  /\bdesign and build\b/i,
  /\bmake me a\b/i,
  /\bfrom scratch\b/i,
  /\bfull(y)? (working|functional)\b/i,
];

export function estimateComplexity(message: string): ComplexityLevel {
  const trimmed = message.trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  const codeBlockCount = (trimmed.match(/```/g) ?? []).length / 2;
  const isOutcomeShaped = OUTCOME_HINTS.some((re) => re.test(trimmed));

  let score = 0;

  if (wordCount > 120) score += 2;
  else if (wordCount > 40) score += 1;

  if (codeBlockCount >= 1) score += 1;
  if (codeBlockCount >= 2) score += 1;

  if (COMPLEX_HINTS.some((re) => re.test(trimmed))) score += 2;

  if (isOutcomeShaped) {
    // Live testing caught "Build me a simple one-page landing site for a
    // coffee shop, with a headline and a short description" scoring as
    // "simple" — SIMPLE_HINTS matched "short" (describing the requested
    // description text's length, not the task's effort) and that alone
    // outweighed everything else, so this never even reached
    // workflow/trigger.ts's shouldUseWorkflow check despite matching its
    // own OUTCOME_HINTS outright. A "build me X" / "create a complete X"
    // request is inherently decomposition-worthy regardless of incidental
    // wording elsewhere in the message; SIMPLE_HINTS exists to catch
    // genuinely low-effort asks ("just fix this typo"), which this isn't.
    score += 3;
  } else if (SIMPLE_HINTS.some((re) => re.test(trimmed))) {
    score -= 2;
  }

  if (wordCount <= 8 && codeBlockCount === 0) score -= 1;

  if (score <= 0) {
    // FIX (user-reported, 2026-09-04): a genuinely long message (already
    // worth +2 above on length alone) could still be dragged all the way
    // back down to a net score of 0 by an incidental SIMPLE_HINTS match
    // anywhere in it — "Can you quickly walk me through this: [500 words
    // of actual content]" matches "quickly" (-2) and cancels the length
    // signal outright, misclassifying a substantial request as "simple"
    // and routing it to the fastest/cheapest tier as if it were a
    // one-line question. A message long enough to have earned the length
    // bonus in the first place floors at "medium" no matter what else
    // dragged its score down; a message that never earned that bonus
    // keeps classifying as "simple" exactly as before.
    return wordCount > 120 ? "medium" : "simple";
  }
  if (score <= 2) return "medium";
  return "complex";
}
