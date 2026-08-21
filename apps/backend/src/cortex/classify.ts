import type { FastifyInstance } from "fastify";
import { INTENTS, GENERAL_FALLBACK_INTENT, type IntentDefinition } from "./intents.js";
import { completeOnce } from "../openrouter/client.js";

export interface ClassificationResult {
  intentId: string;
  category: string;
  capabilities: string[];
  reason: string;
  usedFallback: boolean;
}

const GREETING_RE = /^(hi|hey|hello|yo|sup|hiya)[!.? ]*$/i;

function scoreIntents(message: string): Array<{ intent: IntentDefinition; strongHits: number; weakHits: number }> {
  return INTENTS.map((intent) => {
    const strongHits = intent.strongKeywords.filter((re) => re.test(message)).length;
    const weakHits = intent.weakKeywords.filter((re) => re.test(message)).length;
    return { intent, strongHits, weakHits };
  });
}

function isTooShortOrGeneric(message: string): boolean {
  const trimmed = message.trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  return wordCount < 3 || GREETING_RE.test(trimmed);
}

const CLASSIFIER_SYSTEM_PROMPT = `You classify a user's message into exactly one intent for an AI routing system.
Respond with ONLY a JSON object, no prose, no markdown fences, matching this shape:
{"intentId": string, "category": string, "capabilities": string[], "reason": string}

Valid intentId values: ${INTENTS.map((i) => i.id).join(", ")}
Valid category values: coding, reasoning, math, writing, vision, documents, general, image, audio, video, ppt, web_search, deep_research
"image" means the user wants a NEW image generated/drawn/created — not describing or asking about an existing image (that's "vision").
"audio" means the user wants text converted to spoken audio/speech (text-to-speech, narration, voiceover).
"video" means the user wants a NEW short video/clip/animation generated.
"ppt" means the user wants a presentation / slide deck / PowerPoint file produced.
"web_search" means the request genuinely needs current/external/verifiable web information (news, prices, live status, recent events) that your own training data may not cover — NOT ordinary questions your existing knowledge already answers well (general concepts, how things work, writing help, math). When in doubt, prefer NOT choosing web_search.
"deep_research" means the user explicitly wants a thorough, multi-source research report, not a quick answer — a much higher bar than web_search.
"reason" must be a short (<20 words) human-readable explanation of why you picked this intent.
If uncertain, use intentId "general_qa", category "general".`;

async function classifyWithFallbackModel(fastify: FastifyInstance, message: string): Promise<ClassificationResult> {
  try {
    const { content: raw } = await completeOnce({
      fastify,
      model: fastify.config.CORTEX_CLASSIFIER_MODEL_ID,
      messages: [
        { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
        { role: "user", content: message },
      ],
      maxTokens: 150,
    });

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("no JSON in classifier response");

    const parsed = JSON.parse(jsonMatch[0]) as {
      intentId?: string;
      category?: string;
      capabilities?: string[];
      reason?: string;
    };

    const matchedIntent = INTENTS.find((i) => i.id === parsed.intentId);
    if (!matchedIntent || !parsed.category) throw new Error("classifier returned unknown intent/category");

    return {
      intentId: matchedIntent.id,
      category: parsed.category,
      capabilities: Array.isArray(parsed.capabilities) && parsed.capabilities.length > 0
        ? parsed.capabilities
        : matchedIntent.capabilities,
      reason: parsed.reason ?? "Classified by fallback model.",
      usedFallback: true,
    };
  } catch (err) {
    fastify.log.warn({ err }, "Cortex fallback classification failed, defaulting to general");
    return {
      intentId: GENERAL_FALLBACK_INTENT.id,
      category: GENERAL_FALLBACK_INTENT.category,
      capabilities: GENERAL_FALLBACK_INTENT.capabilities,
      reason: "Defaulted to general assistance after classification was inconclusive.",
      usedFallback: true,
    };
  }
}

export async function classifyIntent(fastify: FastifyInstance, message: string): Promise<ClassificationResult> {
  if (isTooShortOrGeneric(message)) {
    return classifyWithFallbackModel(fastify, message);
  }

  const scored = scoreIntents(message);
  const withStrongHits = scored.filter((s) => s.strongHits > 0);

  if (withStrongHits.length === 1) {
    const { intent } = withStrongHits[0];
    return {
      intentId: intent.id,
      category: intent.category,
      capabilities: intent.capabilities,
      reason: `Matched "${intent.id}" from keyword patterns in your message.`,
      usedFallback: false,
    };
  }

  if (withStrongHits.length === 0) {
    const withWeakHits = scored.filter((s) => s.weakHits > 0).sort((a, b) => b.weakHits - a.weakHits);
    if (withWeakHits.length === 1 || (withWeakHits.length > 1 && withWeakHits[0].weakHits > withWeakHits[1].weakHits)) {
      const { intent } = withWeakHits[0];
      return {
        intentId: intent.id,
        category: intent.category,
        capabilities: intent.capabilities,
        reason: `Matched "${intent.id}" from contextual keywords in your message.`,
        usedFallback: false,
      };
    }
  }

  // Zero matches, or ≥2 competing strong matches — genuinely ambiguous.
  return classifyWithFallbackModel(fastify, message);
}
