import type { FastifyInstance } from "fastify";
import type { PlanTier } from "@splex/shared-types";
import { completeOnceWithFallback, describeError } from "../openrouter/client.js";
import { resolveClassifierModelCandidates } from "./classifierModel.js";

const MAX_SUGGESTIONS = 3;
const MAX_SUGGESTION_CHARS = 80;

const SYSTEM_PROMPT = `Given one exchange between a user and an AI assistant called SPLEX, suggest ${MAX_SUGGESTIONS} short, natural follow-up questions or requests the user might genuinely want to ask next — grounded specifically in what was just discussed, not generic ("tell me more", "what else can you do"). Each should be phrased as something the USER would type, in their own voice, under ${MAX_SUGGESTION_CHARS} characters.

If this exchange doesn't naturally invite a follow-up (a simple greeting, a fully self-contained factual answer with nothing more to explore), return fewer than ${MAX_SUGGESTIONS} — an empty list is a completely valid answer, never force one that doesn't fit.

Respond with ONLY a JSON array of strings, no prose, no markdown fences: ["...", "..."]`;

// Fire-and-forget in spirit (never worth failing or slowing down the main
// response over), but unlike memory extraction this DOES need to reach
// the current response — see its call site in handlers/chat.ts, which
// awaits this before sse.done() rather than scheduling it in the
// background. Kept cheap and fast on purpose so that's a small addition,
// not a real delay: free-tier-eligible models only (same
// resolveClassifierModelCandidates used for memory/classification — this
// is background housekeeping, not a capability either plan is paying
// for), and a short max_tokens ceiling.
export async function generateFollowUpSuggestions(
  fastify: FastifyInstance,
  planTier: PlanTier,
  userMessage: string,
  assistantResponse: string,
): Promise<string[]> {
  try {
    const candidates = await resolveClassifierModelCandidates(fastify, planTier);
    if (candidates.length === 0) return [];

    const { content: raw } = await completeOnceWithFallback(fastify, candidates, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `User: ${userMessage.slice(0, 1500)}\nSPLEX: ${assistantResponse.slice(0, 1500)}`,
        },
      ],
      maxTokens: 200,
    });

    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .map((s) => s.trim().slice(0, MAX_SUGGESTION_CHARS))
      .slice(0, MAX_SUGGESTIONS);
  } catch (err) {
    fastify.log.warn(describeError(err), "follow-up suggestion generation failed — non-fatal, response already complete");
    return [];
  }
}
