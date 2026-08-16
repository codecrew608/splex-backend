import type { FastifyInstance } from "fastify";
import { completeOnce } from "../openrouter/client.js";

// Hybrid trigger, same pattern as Cortex's classifier: don't call an LLM on
// every single turn (cost + latency), only when there's a real signal.
const MEMORABLE_PATTERNS = [
  /\bmy name is\b/i,
  /\bcall me\b/i,
  /\bi('m| am) (a|an|working (on|as))\b/i,
  /\bi (prefer|like|hate|dislike|always|never|usually)\b/i,
  /\bremember (that|this)?\b/i,
  /\bi (live|work) (in|at)\b/i,
  /\bi use\b/i,
  /\bfor (future|context)\b/i,
];

const PERIODIC_TURN_INTERVAL = 8;

export function shouldExtractMemory(userMessage: string, turnNumber: number): boolean {
  if (MEMORABLE_PATTERNS.some((p) => p.test(userMessage))) return true;
  return turnNumber > 0 && turnNumber % PERIODIC_TURN_INTERVAL === 0;
}

const EXTRACT_SYSTEM_PROMPT = `You maintain a concise, durable memory profile for a user of an AI assistant called SPLEX. Given the user's EXISTING memory summary and a NEW conversation exchange, decide if there's a new durable fact worth remembering — identity, stated preferences, ongoing projects/work, communication style. NOT conversational trivia, NOT one-off task details, NOT anything already covered.

Respond with ONLY a JSON object, no prose, no markdown fences:
{"changed": boolean, "summary": string}

If nothing new/durable, set changed:false and return the existing summary unchanged in "summary". Keep the summary under 300 words, third-person, factual bullet-style (one fact per line, prefixed with "- ").`;

// Fire-and-forget from the caller (never awaited on the response path) —
// this must never add latency to what the user sees, and a failure here
// should never surface as a chat error.
export async function extractAndUpdateMemory(
  fastify: FastifyInstance,
  userId: string,
  userMessage: string,
  assistantResponse: string,
): Promise<void> {
  try {
    const { data: memoryRow } = await fastify.supabaseAdmin
      .from("user_memory")
      .select("summary_text")
      .eq("user_id", userId)
      .maybeSingle();

    const existingSummary = memoryRow?.summary_text ?? "";

    const { content: raw } = await completeOnce({
      fastify,
      model: fastify.config.CORTEX_CLASSIFIER_MODEL_ID,
      messages: [
        { role: "system", content: EXTRACT_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Existing memory:\n${existingSummary || "(empty)"}\n\nNew exchange:\nUser: ${userMessage.slice(0, 2000)}\nAssistant: ${assistantResponse.slice(0, 2000)}`,
        },
      ],
      maxTokens: 500,
    });

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const parsed = JSON.parse(jsonMatch[0]) as { changed?: boolean; summary?: string };
    if (!parsed.changed || typeof parsed.summary !== "string" || !parsed.summary.trim()) return;

    await fastify.supabaseAdmin
      .from("user_memory")
      .upsert({ user_id: userId, summary_text: parsed.summary.trim() }, { onConflict: "user_id" });
  } catch (err) {
    fastify.log.warn({ err }, "memory extraction failed — non-fatal, response already sent");
  }
}
