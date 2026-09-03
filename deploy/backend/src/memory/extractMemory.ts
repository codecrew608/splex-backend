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
  // FIX (structured memory pass): "forget X" never matched anything above
  // — MEMORABLE_PATTERNS only ever gated additions, so a user explicitly
  // asking to forget something silently did nothing unless it happened to
  // land on the periodic fallback turn. A false-positive trigger here just
  // costs one LLM call that returns {upserts:[],deletes:[]} — cheap
  // insurance against the alternative (an explicit request to forget
  // something being ignored).
  /\bforget\b/i,
  /\bdon't remember\b/i,
  /\bno longer\b/i,
];

// turnNumber comes from the CURRENT conversation's own history length
// (routes/chat.ts), which resets to 0 every time the user starts a new
// chat — so a fixed "every Nth turn" fallback effectively never fires for
// anyone who mostly starts fresh conversations rather than running long
// ones, independent of PERIODIC_TURN_INTERVAL's actual value. Below a
// real per-user counter (which would need an extra query every turn just
// to decide whether to run one), extracting more eagerly while a user's
// profile is still small is what actually closes that gap: it uses data
// already fetched for this request (chat.ts already loads user_memories
// to build the system prompt), costs nothing extra to check, and
// naturally backs off once a real profile exists.
const EARLY_PROFILE_TURN_INTERVAL = 2;
const ESTABLISHED_PROFILE_TURN_INTERVAL = 5;
const MIN_ESTABLISHED_FACT_COUNT = 4;

export function shouldExtractMemory(userMessage: string, turnNumber: number, existingFactCount: number): boolean {
  if (MEMORABLE_PATTERNS.some((p) => p.test(userMessage))) return true;
  const interval = existingFactCount < MIN_ESTABLISHED_FACT_COUNT ? EARLY_PROFILE_TURN_INTERVAL : ESTABLISHED_PROFILE_TURN_INTERVAL;
  return turnNumber > 0 && turnNumber % interval === 0;
}

// STRUCTURED memory, not a single free-text blob (see migration 0037's own
// comment for why: "delete one fact" has no honest implementation against
// a paragraph). Each fact gets a short, stable key so restating the same
// thing later overwrites in place (upsert) instead of accumulating
// duplicates, and "forget X" becomes a real delete instead of asking a
// summarization model to somehow edit a paragraph out from under itself.
const EXTRACT_SYSTEM_PROMPT = `You maintain a structured memory profile for a user of an AI assistant called SPLEX. Given the user's EXISTING facts (as key: fact pairs) and a NEW conversation exchange, decide what to remember or forget.

Only extract information that is EXPLICITLY stated by the user as being about them, and that is durable — identity (name), stated preferences (e.g. response length/style), ongoing projects or work, communication style. Do NOT extract: conversational trivia, one-off task details, anything already covered by an existing fact with the same meaning, or anything you are inferring/guessing rather than something the user actually said.

NEVER extract passwords, API keys, tokens, credit card or bank account numbers, government ID numbers, or any other authentication secret or payment credential — even if the user includes one in their message. If the only "durable" thing in the message is a secret like this, treat it as nothing worth remembering.

Each fact needs a short, stable "key" so restating the same thing later updates it instead of creating a duplicate — reuse the EXISTING key when a fact is about the same thing (e.g. always "name" for the user's name, "preference:response_length" for how verbose to be), and invent a new short snake_case key only for a genuinely new kind of fact.

If the user asks you to forget, stop remembering, or says something no longer applies, put that fact's key in "deletes" — match it against the EXISTING facts by meaning, not just literal wording.

Respond with ONLY a JSON object, no prose, no markdown fences:
{"upserts": [{"key": string, "fact": string}], "deletes": [string]}

Both arrays may be empty. "fact" should be a short, third-person, factual sentence (e.g. "Prefers concise answers." not "I like short answers").`;

interface ExtractedMemory {
  upserts?: Array<{ key?: unknown; fact?: unknown }>;
  deletes?: unknown;
}

export interface MemoryFact {
  fact_key: string;
  fact: string;
}

// Every chat turn's own read of the user's current memory — used both to
// build the system prompt's context block and to decide (via
// shouldExtractMemory's factCount) how eagerly to extract more. A plain
// SELECT scoped by RLS-equivalent user_id filtering (this runs on
// supabaseAdmin, service role — the filter here IS the authorization,
// same as every other server-side query in this codebase).
export async function fetchMemoryFacts(fastify: FastifyInstance, userId: string): Promise<MemoryFact[]> {
  const { data, error } = await fastify.supabaseAdmin.from("user_memories").select("fact_key, fact").eq("user_id", userId);
  if (error || !data) return [];
  return data as MemoryFact[];
}

// Legacy fallback only — real reads now go through fetchMemoryFacts
// above. See migration 0037's comment: user_memory (the old single-blob
// table) is kept, unmigrated, so a user's pre-existing memory isn't
// silently discarded; this is consulted only when the user has zero rows
// in the new table yet.
async function fetchLegacySummary(fastify: FastifyInstance, userId: string): Promise<string | null> {
  const { data } = await fastify.supabaseAdmin.from("user_memory").select("summary_text").eq("user_id", userId).maybeSingle();
  return data?.summary_text || null;
}

// Builds the block threaded into buildSystemPrompt/contextBlock. fullName
// (if the user completed onboarding) always comes first as a plain
// sentence — see its call site in chat.ts for why date_of_birth is
// deliberately never included here. Falls back to the legacy blob (see
// fetchLegacySummary above) only when this user has no structured facts
// yet, so nobody's already-remembered context silently disappears the
// moment this shipped.
export async function buildMemorySummary(fastify: FastifyInstance, userId: string, fullName: string | null, facts: MemoryFact[]): Promise<string> {
  const lines: string[] = [];
  if (fullName) lines.push(`The user's name is ${fullName}.`);

  if (facts.length > 0) {
    for (const f of facts) lines.push(`- ${f.fact}`);
  } else {
    const legacy = await fetchLegacySummary(fastify, userId);
    if (legacy) lines.push(legacy);
  }

  return lines.join("\n");
}

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
    const { data: existingRows } = await fastify.supabaseAdmin
      .from("user_memories")
      .select("fact_key, fact")
      .eq("user_id", userId);

    const existingBlock =
      existingRows && existingRows.length > 0
        ? existingRows.map((r: { fact_key: string; fact: string }) => `${r.fact_key}: ${r.fact}`).join("\n")
        : "(none yet)";

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
          content: `Existing facts:\n${existingBlock}\n\nNew exchange:\nUser: ${userMessage.slice(0, 2000)}\nAssistant: ${assistantResponse.slice(0, 2000)}`,
        },
      ],
      maxTokens: 500,
    });

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const parsed = JSON.parse(jsonMatch[0]) as ExtractedMemory;

    const upserts = (Array.isArray(parsed.upserts) ? parsed.upserts : [])
      .filter((u): u is { key: string; fact: string } => typeof u?.key === "string" && u.key.trim().length > 0 && typeof u?.fact === "string" && u.fact.trim().length > 0)
      // Defense in depth alongside the prompt's own instruction — a model
      // that ignores instructions once can ignore them twice. Never
      // persist anything that looks like a secret/credential regardless
      // of what the model decided to label it.
      .filter((u) => !looksLikeSecret(u.fact))
      .slice(0, 5); // one exchange should never plausibly produce more than a few real facts — a runaway response is a bug, not a memory dump

    const deletes = (Array.isArray(parsed.deletes) ? parsed.deletes : []).filter((k): k is string => typeof k === "string" && k.trim().length > 0);

    if (upserts.length === 0 && deletes.length === 0) return;

    // The model is never allowed to write directly — this function (server
    // only, service_role) is the sole write path for anything beyond a
    // user's own explicit delete via the Memory settings page.
    if (upserts.length > 0) {
      await fastify.supabaseAdmin.from("user_memories").upsert(
        upserts.map((u) => ({
          user_id: userId,
          fact_key: u.key.trim().slice(0, 100),
          fact: u.fact.trim().slice(0, 500),
          updated_at: new Date().toISOString(),
        })),
        { onConflict: "user_id,fact_key" },
      );
    }
    if (deletes.length > 0) {
      await fastify.supabaseAdmin.from("user_memories").delete().eq("user_id", userId).in("fact_key", deletes.slice(0, 20));
    }
  } catch (err) {
    fastify.log.warn(describeError(err), "memory extraction failed — non-fatal, response already sent");
  }
}

// Coarse, deliberately over-inclusive pattern match — the prompt already
// tells the model not to extract these; this is the backstop for when it
// does anyway. False positives (a legitimate fact happens to contain a
// long digit run) just mean one fact doesn't get saved, which is a far
// better failure mode than persisting a credential into a place the
// assistant reads back into every future conversation.
const SECRET_LIKE_PATTERNS = [
  /\b[A-Za-z0-9_-]{20,}\b/, // long opaque tokens (API keys, JWTs, etc.)
  /\b\d{13,19}\b/, // card-number-length digit runs
  /\bsk-[A-Za-z0-9]/i, // common API key prefix convention
  /\bpassword\s*[:=]/i,
  /\bapi[_ -]?key\s*[:=]/i,
];

// Exported for direct unit testing (test/memory.test.ts) — this is the
// defense-in-depth backstop for a prompt-injection-style failure (the
// model extracts a secret despite being told not to), so it needs real
// behavioral coverage, not just a source-text pin.
export function looksLikeSecret(fact: string): boolean {
  return SECRET_LIKE_PATTERNS.some((p) => p.test(fact));
}
