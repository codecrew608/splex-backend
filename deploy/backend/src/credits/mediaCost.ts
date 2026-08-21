import type { FastifyInstance } from "fastify";

const DEFAULT_CREDITS_PER_USD = 25_000;

// Media generation (image, audio, video, PPT) is priced per-call by
// OpenRouter, not per-token, so it doesn't go through realCost.ts's
// token-rate math — this converts the real USD cost of a single generation
// straight to SPLEX credits at the same $-to-credits rate every other
// category uses. Callers resolve the real cost differently per kind (see
// apps/backend/src/images/generate.ts and apps/backend/src/audio/generate.ts)
// but all funnel through this one conversion.
export function computeMediaCreditsCharged(fastify: FastifyInstance, costUsd: number): number {
  const creditsPerUsd = fastify.config.CREDITS_PER_USD ?? DEFAULT_CREDITS_PER_USD;
  return Math.max(1, Math.ceil(costUsd * creditsPerUsd));
}
