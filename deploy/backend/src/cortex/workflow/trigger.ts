import type { ComplexityLevel } from "../../shared-types.js";

// Deliberately conservative and NOT an LLM call — same regex-hint-scoring
// pattern as complexity.ts. Under-triggering is safer than starting a
// multi-charge workflow on an ordinary complex question ("explain quantum
// computing comprehensively" is complex but not outcome-shaped).
const OUTCOME_HINTS = [
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

export function shouldUseWorkflow(complexity: ComplexityLevel, message: string): boolean {
  return complexity === "complex" && OUTCOME_HINTS.some((re) => re.test(message));
}
