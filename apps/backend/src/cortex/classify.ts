import type { FastifyInstance } from "fastify";
import { INTENTS, GENERAL_FALLBACK_INTENT, type IntentDefinition } from "./intents.js";
import { completeOnceWithFallback } from "../openrouter/client.js";
import { resolveClassifierModelCandidates } from "./classifierModel.js";
import type { PlanTier } from "@splex/shared-types";

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

async function classifyWithFallbackModel(fastify: FastifyInstance, message: string, planTier: PlanTier): Promise<ClassificationResult> {
  try {
    // Tier-aware: a Free request must never reach a paid model. An empty
    // candidate list means no free classifier is available at all, so skip
    // the call entirely rather than spending — the catch below already
    // produces exactly the right degraded result for that case.
    //
    // completeOnceWithFallback tries every active candidate in priority
    // order rather than just the top one — a single rate-limited free
    // model (observed live) used to make this whole fallback classifier
    // fail outright, silently defaulting every affected message to
    // "general" even when other free models were available.
    const classifierCandidates = await resolveClassifierModelCandidates(fastify, planTier);
    if (classifierCandidates.length === 0) throw new Error("no free classifier model available");

    const { content: raw } = await completeOnceWithFallback(fastify, classifierCandidates, {
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

export async function classifyIntent(fastify: FastifyInstance, message: string, planTier: PlanTier): Promise<ClassificationResult> {
  // Greetings resolve deterministically — no classifier round-trip.
  //
  // This is the single biggest latency win available on short messages,
  // and the old ordering had it exactly backwards: isTooShortOrGeneric()
  // ran BEFORE any keyword scoring, so the smallest, most obvious inputs
  // ("hi") were the ones that paid for a full extra LLM call before the
  // real answer could even start — roughly doubling time-to-first-token on
  // precisely the messages a user expects to be instant.
  //
  // Safe because GREETING_RE is anchored (^...$) and matches only a bare
  // salutation with trailing punctuation: "hi", "hello!", "yo". A greeting
  // cannot secretly be an image or math request, so there is nothing for a
  // classifier to discover here that the regex hasn't already settled.
  if (GREETING_RE.test(message.trim())) {
    return {
      intentId: GENERAL_FALLBACK_INTENT.id,
      category: GENERAL_FALLBACK_INTENT.category,
      capabilities: GENERAL_FALLBACK_INTENT.capabilities,
      reason: "Greeting — answered directly without a routing lookup.",
      usedFallback: false,
    };
  }

  // Keyword scoring now runs BEFORE the short-message check, so a terse
  // but unambiguous request resolves deterministically instead of paying
  // for the classifier. Verified against the real intent table: "draw cat"
  // is two words (old code: straight to the LLM) but carries a weak
  // image_generation hit, so it now routes correctly AND instantly.
  // Genuinely signal-free short input ("2+2", "tts this") still falls
  // through to the classifier below — those carry real routing nuance that
  // keywords can't settle, and quietly defaulting them to general would
  // misroute media requests.
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

  // Zero matches, ≥2 competing strong matches, or a short message with no
  // keyword signal — genuinely ambiguous, so pay for the classifier.
  // isTooShortOrGeneric is still consulted (not dead) as a readability
  // marker for why a message with no hits reached here.
  if (isTooShortOrGeneric(message)) {
    fastify.log.debug({ wordCount: message.trim().split(/\s+/).length }, "short message with no keyword signal — using classifier");
  }
  return classifyWithFallbackModel(fastify, message, planTier);
}
