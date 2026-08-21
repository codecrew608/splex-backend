import type { FastifyInstance } from "fastify";
import { completeOnce } from "../openrouter/client.js";
import type { OpenRouterUsage } from "../types/index.js";

export interface SlidePlan {
  title: string;
  bullets: string[];
  notes?: string;
}

export interface DeckPlan {
  title: string;
  subtitle: string;
  slides: SlidePlan[];
}

export interface DeckPlanResult {
  plan: DeckPlan;
  usage: OpenRouterUsage | null;
}

const MIN_SLIDES = 3;
const MAX_SLIDES = 12;
const MAX_BULLETS_PER_SLIDE = 6;

// One structured call rather than the spec's literal
// outline-then-content-then-visuals chain: each extra LLM round trip is
// real latency and real money for the same deliverable, and this model
// produces a full deck outline + per-slide bullets in a single pass
// reliably. The spec's own overriding rule — "Do not add unnecessary LLM
// calls... use the cheapest model capable of each subtask" — points here.
// If deck quality ever proves insufficient in practice, splitting this
// into outline->expand is a contained change to this file alone.
const DECK_SYSTEM_PROMPT = `You design presentation decks. Respond with ONLY a JSON object, no prose, no markdown fences, matching:
{"title": string, "subtitle": string, "slides": [{"title": string, "bullets": string[], "notes": string}]}

Rules:
- Between ${MIN_SLIDES} and ${MAX_SLIDES} slides, chosen to fit the topic — do not pad.
- Each slide: 3-${MAX_BULLETS_PER_SLIDE} bullets, each a concise phrase (max ~14 words), not a paragraph.
- "notes" is a one-or-two-sentence speaker note for that slide.
- Do not include a closing "Thank you"/"Questions?" slide.
- Plain text only in every field: no markdown, no bullet characters, no numbering.`;

function coerceSlide(raw: unknown): SlidePlan | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as { title?: unknown; bullets?: unknown; notes?: unknown };
  const title = typeof r.title === "string" ? r.title.trim() : "";
  if (!title) return null;

  const bullets = Array.isArray(r.bullets)
    ? r.bullets.filter((b): b is string => typeof b === "string" && b.trim().length > 0)
        .map((b) => b.trim())
        .slice(0, MAX_BULLETS_PER_SLIDE)
    : [];
  if (bullets.length === 0) return null;

  return { title, bullets, notes: typeof r.notes === "string" ? r.notes.trim() : undefined };
}

// Same "regex-extract {...}, JSON.parse, validate, degrade gracefully"
// shape as classify.ts and extractMemory.ts. Throws (rather than
// returning a half-empty deck) when the model gives nothing usable — the
// caller treats that as a failed generation, so the user isn't charged
// for and handed a broken one-slide file.
export async function planDeck(fastify: FastifyInstance, model: string, prompt: string): Promise<DeckPlanResult> {
  const { content: raw, usage } = await completeOnce({
    fastify,
    model,
    messages: [
      { role: "system", content: DECK_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    // Generous relative to other completeOnce callers (classifier: 150) —
    // a full 12-slide deck of bullets genuinely needs the room, and
    // truncation here produces invalid JSON rather than a shorter deck.
    maxTokens: 3000,
  });

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("deck planner returned no JSON");

  const parsed = JSON.parse(jsonMatch[0]) as { title?: unknown; subtitle?: unknown; slides?: unknown };

  const slides = Array.isArray(parsed.slides)
    ? parsed.slides.map(coerceSlide).filter((s): s is SlidePlan => s !== null).slice(0, MAX_SLIDES)
    : [];
  if (slides.length === 0) throw new Error("deck planner returned no usable slides");

  return {
    plan: {
      title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : "Presentation",
      subtitle: typeof parsed.subtitle === "string" ? parsed.subtitle.trim() : "",
      slides,
    },
    usage,
  };
}
