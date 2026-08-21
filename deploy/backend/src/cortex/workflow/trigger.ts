import type { ComplexityLevel } from "../../shared-types.js";
import { OUTCOME_HINTS } from "../complexity.js";

// Deliberately conservative and NOT an LLM call — same regex-hint-scoring
// pattern as complexity.ts (which is also where OUTCOME_HINTS now lives —
// estimateComplexity checks it directly too, see that file's comment).
// Under-triggering is safer than starting a multi-charge workflow on an
// ordinary complex question ("explain quantum computing comprehensively"
// is complex but not outcome-shaped).
export function shouldUseWorkflow(complexity: ComplexityLevel, message: string): boolean {
  return complexity === "complex" && OUTCOME_HINTS.some((re) => re.test(message));
}
