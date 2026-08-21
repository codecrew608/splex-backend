import type { FastifyInstance } from "fastify";
import type { ModelRegistryRow } from "../types/index.js";
import { storeGeneratedMedia } from "../media/storage.js";
import { computeRealCost } from "../credits/realCost.js";
import { planDeck } from "./plan.js";
import { buildPptx } from "./build.js";

export interface GeneratePptResult {
  url: string;
  storagePath: string;
  costUsd: number;
  slideCount: number;
}

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

// Prompt -> deck. Two stages, only the first of which touches a model:
// plan the deck as structured JSON (plan.ts), then assemble the real .pptx
// locally (build.ts). Stored in the same private bucket every other
// generated-media kind uses, delivered by signed URL.
//
// Unlike image/audio/video, cost here is TOKEN-based, not per-call — the
// "model" for this category is an ordinary cheap text model (see migration
// 0015), so this reuses the existing computeRealCost path rather than
// mediaCost's per-call conversion. That's why this takes the full
// ModelRegistryRow: it needs the row's pricing, not just its id.
export async function generatePpt(
  fastify: FastifyInstance,
  userId: string,
  model: ModelRegistryRow,
  prompt: string,
): Promise<GeneratePptResult> {
  const { plan, usage } = await planDeck(fastify, model.openrouter_model_id, prompt);
  const bytes = await buildPptx(plan);

  const stored = await storeGeneratedMedia(fastify, userId, bytes, PPTX_MIME, "pptx");
  const realCost = await computeRealCost(fastify, "ppt", model, usage);

  return {
    ...stored,
    costUsd: realCost.realCostEstimateUsd,
    slideCount: plan.slides.length,
  };
}
