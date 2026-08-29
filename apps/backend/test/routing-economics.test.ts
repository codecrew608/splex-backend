import { describe, it, expect } from "vitest";
import { scoreModels, resolveRoutingProfile } from "../src/cortex/routing.js";
import type { ModelRegistryRow } from "../src/types/index.js";

// Post-migration-0032 rows, exact values from the migration file, used to
// verify the REAL scoring code (not hand arithmetic) realizes the spec's
// stated primary/fallback ordering for each category.
function row(over: Partial<ModelRegistryRow>): ModelRegistryRow {
  return {
    id: over.openrouter_model_id + ":" + over.category, category: "general",
    openrouter_model_id: "x", variant: "paid", capability_score: 80,
    context_length: 1000000, cost_per_million_input: 1, cost_per_million_output: 1,
    is_active: true, priority: 10, ...over,
  };
}

const GLM_R = row({ category: "reasoning", openrouter_model_id: "z-ai/glm-5.2", capability_score: 92, reasoning_score: 92, cost_per_million_input: 1.19, cost_per_million_output: 3.74 });
const NEM_R = row({ category: "reasoning", openrouter_model_id: "nvidia/nemotron-3-ultra-550b-a55b", capability_score: 90, reasoning_score: 87, cost_per_million_input: 0.50, cost_per_million_output: 2.20 });
const V4P_R = row({ category: "reasoning", openrouter_model_id: "deepseek/deepseek-v4-pro-0813", capability_score: 92, reasoning_score: 78, cost_per_million_input: 0.66, cost_per_million_output: 1.98 });

const NEM_M = row({ category: "math", openrouter_model_id: "nvidia/nemotron-3-ultra-550b-a55b", capability_score: 91, reasoning_score: 91, cost_per_million_input: 0.50, cost_per_million_output: 2.20 });
const V4P_M = row({ category: "math", openrouter_model_id: "deepseek/deepseek-v4-pro-0813", capability_score: 92, reasoning_score: 82, cost_per_million_input: 0.66, cost_per_million_output: 1.98 });
const GLM_M = row({ category: "math", openrouter_model_id: "z-ai/glm-5.2", capability_score: 89, reasoning_score: 76, cost_per_million_input: 1.19, cost_per_million_output: 3.74 });

const GLM_C = row({ category: "coding", openrouter_model_id: "z-ai/glm-5.2", capability_score: 92, coding_score: 92, cost_per_million_input: 1.19, cost_per_million_output: 3.74 });
const NEM_C = row({ category: "coding", openrouter_model_id: "nvidia/nemotron-3-ultra-550b-a55b", capability_score: 88, coding_score: 85, cost_per_million_input: 0.50, cost_per_million_output: 2.20 });
const V4P_C = row({ category: "coding", openrouter_model_id: "deepseek/deepseek-v4-pro-0813", capability_score: 94, coding_score: 76, cost_per_million_input: 0.66, cost_per_million_output: 1.98 });
const FLASH_C = row({ category: "coding", openrouter_model_id: "deepseek/deepseek-v4-flash-0731", capability_score: 88, coding_score: 80, cost_per_million_input: 0.045, cost_per_million_output: 0.09 });

const winner = (models: ModelRegistryRow[], category: string, complexity: "simple"|"medium"|"complex") => {
  const profile = resolveRoutingProfile(category, complexity);
  const scored = scoreModels(models, new Map(), category, complexity, "v1.5");
  return { top: [...scored].sort((a, b) => b.score - a.score)[0].model.openrouter_model_id, profile };
};

describe("REAL scoring code realizes the spec's stated ordering (post-0032)", () => {
  it("reasoning: GLM beats V4 Pro despite V4 Pro's higher/tied raw quality", () => {
    const { top, profile } = winner([GLM_R, NEM_R, V4P_R], "reasoning", "complex");
    expect(profile).toBe("deep_quality");
    expect(top).toBe("z-ai/glm-5.2");
  });

  it("reasoning: GLM beats Nemotron", () => {
    const { top } = winner([GLM_R, NEM_R], "reasoning", "complex");
    expect(top).toBe("z-ai/glm-5.2");
  });

  it("reasoning: V4 Pro is not excluded — it beats a hypothetical weaker candidate", () => {
    const weak = row({ category: "reasoning", openrouter_model_id: "weak/model", capability_score: 60, reasoning_score: 60, cost_per_million_input: 0.05, cost_per_million_output: 0.05 });
    const { top } = winner([V4P_R, weak], "reasoning", "complex");
    expect(top).toBe("deepseek/deepseek-v4-pro-0813");
  });

  it("math: Nemotron beats V4 Pro despite V4 Pro's higher raw quality AND lower cost", () => {
    const { top, profile } = winner([NEM_M, V4P_M, GLM_M], "math", "complex");
    expect(profile).toBe("deep_quality");
    expect(top).toBe("nvidia/nemotron-3-ultra-550b-a55b");
  });

  it("math: V4 Pro (fallback #2) beats GLM (fallback #3)", () => {
    const { top } = winner([V4P_M, GLM_M], "math", "complex");
    expect(top).toBe("deepseek/deepseek-v4-pro-0813");
  });

  it("coding: GLM beats V4 Pro despite V4 Pro's highest raw quality (94) AND lower cost", () => {
    // resolveRoutingProfile checks category==='coding' BEFORE complexity, so
    // coding ALWAYS uses the 'coding' profile regardless of complexity —
    // existing, correct behaviour, not something this pass changes.
    const { top, profile } = winner([GLM_C, NEM_C, V4P_C, FLASH_C], "coding", "complex");
    expect(profile).toBe("coding");
    expect(top).toBe("z-ai/glm-5.2");
  });

  it("coding at ordinary (non-complex) complexity uses the 'coding' profile and GLM still wins", () => {
    const { top, profile } = winner([GLM_C, NEM_C, V4P_C, FLASH_C], "coding", "medium");
    expect(profile).toBe("coding");
    expect(top).toBe("z-ai/glm-5.2");
  });

  it("coding: GLM beats Nemotron", () => {
    const { top } = winner([GLM_C, NEM_C], "coding", "medium");
    expect(top).toBe("z-ai/glm-5.2");
  });

  it("coding: GLM beats Flash outright (the case that first exposed the weight defect)", () => {
    const { top } = winner([GLM_C, FLASH_C], "coding", "medium");
    expect(top).toBe("z-ai/glm-5.2");
  });

  it("documents: MiniMax M3 wins for complex/long-context work", () => {
    const MINIMAX_D = row({ category: "documents", openrouter_model_id: "minimax/minimax-m3", capability_score: 87, cost_per_million_input: 0.30, cost_per_million_output: 1.20 });
    const V4P_D = row({ category: "documents", openrouter_model_id: "deepseek/deepseek-v4-pro-0813", capability_score: 88, cost_per_million_input: 0.66, cost_per_million_output: 1.98 });
    const GLM_D = row({ category: "documents", openrouter_model_id: "z-ai/glm-5.2", capability_score: 88, cost_per_million_input: 1.19, cost_per_million_output: 3.74 });
    const { top } = winner([MINIMAX_D, V4P_D, GLM_D], "documents", "complex");
    expect(top).toBe("minimax/minimax-m3");
  });
});
