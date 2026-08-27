import type { FastifyInstance } from "fastify";
import type { ComplexityLevel } from "../shared-types.js";
import { classifyIntent } from "./classify.js";
import { estimateComplexity } from "./complexity.js";
import { categoryToLabel } from "./labels.js";

export interface CortexDecision {
  intentId: string;
  category: string;
  categoryLabel: string;
  capabilities: string[];
  complexity: ComplexityLevel;
  reason: string;
}

export async function runCortexClassification(fastify: FastifyInstance, message: string): Promise<CortexDecision> {
  const classification = await classifyIntent(fastify, message);
  const complexity = estimateComplexity(message);

  return {
    intentId: classification.intentId,
    category: classification.category,
    categoryLabel: categoryToLabel(classification.category),
    capabilities: classification.capabilities,
    complexity,
    reason: classification.reason,
  };
}

export { selectModel, selectModelCandidates } from "./modelSelect.js";
export { categoryToLabel } from "./labels.js";
export { SPLEX_SYSTEM_PROMPT, buildSystemPrompt } from "./systemPrompt.js";
export { buildProjectContext } from "./userContext.js";
export { resolveCortexVersion } from "./version.js";
export type { CortexVersion } from "./version.js";
export { friendlyModelName, explainModelSelection } from "./modelDisplay.js";
