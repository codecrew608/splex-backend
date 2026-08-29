import type { FastifyInstance } from "fastify";
import { completeOnce, describeError } from "../openrouter/client.js";
import { resolveClassifierModel } from "../cortex/classifierModel.js";
import type { PlanTier } from "../shared-types.js";

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
  // Broadened — live evidence (real user_memory rows sampled from
  // production: every one had summary_text === "") showed the original
  // pattern list plus an every-8th-turn fallback was too narrow to ever
  // fire for most real conversations, so memory stayed empty indefinitely.
  /\bmy (job|role|company|team|project) is\b/i,
  /\bi('m| am) (building|working on|trying to)\b/i,
  /\bi need\b/i,
  /\bfrom now on\b/i,
  /\bin the future\b/i,
];

// turnNumber comes from the CURRENT conversation's own history length
// (routes/chat.ts), which resets to 0 every time the user starts a new
// chat — so a fixed "every Nth turn" fallback effectively never fires for
// anyone who mostly starts fresh conversations rather than running long
// ones, independent of PERIODIC_TURN_INTERVAL's actual value. Below a
// real per-user counter (which would need an extra query every turn just
// to decide whether to run one), extracting more eagerly while a user's
// summary is still near-empty is what actually closes that gap: it uses
// data already fetched for this request (routes/chat.ts already loads
// user_memory to build the system prompt), costs nothing extra to check,
// and naturally backs off once a real profile exists.
const EARLY_PROFILE_TURN_INTERVAL = 2;
const ESTABLISHED_PROFILE_TURN_INTERVAL = 5;
const MIN_ESTABLISHED_SUMMARY_LENGTH = 200;

export function shouldExtractMemory(userMessage: string, turnNumber: number, existingSummaryLength: number): boolean {
  if (MEMORABLE_PATTERNS.some((p) => p.test(userMessage))) return true;
  const interval = existingSummaryLength < MIN_ESTABLISHED_SUMMARY_LENGTH ? EARLY_PROFILE_TURN_INTERVAL : ESTABLISHED_PROFILE_TURN_INTERVAL;
  return turnNumber > 0 && turnNumber % interval === 0;
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
  planTier: PlanTier,
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

    // Tier-aware — memory upkeep for a Free user must not bill the paid
    // account (see resolveClassifierModel). null means no free model is
    // available; memory extraction is best-effort background upkeep, so
    // skipping it costs the user nothing visible, whereas paying for it
    // would be an unauthorised charge on a Free account.
    const memoryModel = await resolveClassifierModel(fastify, planTier);
    if (!memoryModel) return;

    const { content: raw } = await completeOnce({
      fastify,
      model: memoryModel,
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
    fastify.log.warn(describeError(err), "memory extraction failed — non-fatal, response already sent");
  }
}
