import type { FastifyInstance } from "fastify";
import type { ComplexityLevel, MessageRole } from "../shared-types.js";

// 'streaming' rows are the durable-persistence fix's whole point: every
// generation path inserts one of these BEFORE calling the provider, then
// finalizes it via updateMessageResult below — so a client that
// disconnects mid-generation (navigation, refresh, tab close) always has
// a real row to find on return, not a hole where the assistant's turn
// never existed. 'failed' rows always carry a short, honest content
// string (never blank) — see each finalize call site's own comment for
// exactly what that string says. See db/migrations/0035_*.sql for the
// column itself.
export type MessageStatus = "complete" | "streaming" | "failed";

export interface InsertMessageParams {
  conversationId: string;
  role: MessageRole;
  content: string;
  intent?: string;
  complexity?: ComplexityLevel;
  creditsCharged?: number;
  routedModel?: string; // INTERNAL ONLY — real openrouter_model_id.
  // Omitted (default 'complete') by every call site that already knows
  // its final content at insert time — user messages, and every
  // capability's older insert-once-at-the-end call sites not yet
  // migrated to the upfront-insert/finalize pattern. Pass 'streaming'
  // explicitly when inserting a not-yet-finished placeholder.
  status?: MessageStatus;
}

export async function insertMessage(fastify: FastifyInstance, params: InsertMessageParams): Promise<string> {
  const { data, error } = await fastify.supabaseAdmin
    .from("messages")
    .insert({
      conversation_id: params.conversationId,
      role: params.role,
      content: params.content,
      intent: params.intent ?? null,
      complexity: params.complexity ?? null,
      credits_charged: params.creditsCharged ?? null,
      routed_model: params.routedModel ?? null,
      status: params.status ?? "complete",
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error("Failed to persist message.");
  }

  return data.id as string;
}

export async function deleteMessage(fastify: FastifyInstance, messageId: string): Promise<void> {
  await fastify.supabaseAdmin.from("messages").delete().eq("id", messageId);
}

export interface UpdateMessageResultParams {
  content: string;
  creditsCharged?: number;
  routedModel?: string; // INTERNAL ONLY — real openrouter_model_id.
  intent?: string;
  complexity?: ComplexityLevel;
  // Defaults to 'complete' — every finalize call site EXCEPT an explicit
  // failure path wants that, so failure is the one place that has to say
  // so, not the common case.
  status?: MessageStatus;
}

// Patches a previously-inserted message's final content in place. Used by
// every capability that now inserts a 'streaming' placeholder before
// generation starts (plain chat, image/audio/ppt, web search, deep
// research) to write the real result once generation finishes — and by
// async media (video), whose placeholder ("Generating your video...")
// predates this pattern and gets rewritten here once the job completes,
// so a page reload shows the real result instead of the stale
// placeholder.
export async function updateMessageResult(
  fastify: FastifyInstance,
  messageId: string,
  params: UpdateMessageResultParams,
): Promise<void> {
  const update: Record<string, unknown> = {
    content: params.content,
    status: params.status ?? "complete",
  };
  // Only touch these columns when the caller actually passes them —
  // video's existing call sites never did and must keep leaving
  // credits_charged/routed_model/intent/complexity exactly as they were
  // set at insert time (recordMediaGeneration/consumeCredits own that
  // data independently for video's flow).
  if (params.creditsCharged !== undefined) update.credits_charged = params.creditsCharged;
  if (params.routedModel !== undefined) update.routed_model = params.routedModel;
  if (params.intent !== undefined) update.intent = params.intent;
  if (params.complexity !== undefined) update.complexity = params.complexity;

  const { error } = await fastify.supabaseAdmin.from("messages").update(update).eq("id", messageId);

  if (error) {
    fastify.log.error({ error, messageId }, "failed to update message with final result");
  }
}

export interface HistoryMessage {
  role: MessageRole;
  content: string;
}

const HISTORY_LIMIT = 20;

export async function fetchRecentHistory(fastify: FastifyInstance, conversationId: string): Promise<HistoryMessage[]> {
  const { data, error } = await fastify.supabaseAdmin
    .from("messages")
    .select("role, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);

  if (error || !data) return [];

  return dropOrphanedUserTurns((data as Array<{ role: MessageRole; content: string }>).reverse());
}

// Defence in depth for the ANSWER-BLEED bug (real production incident,
// 2026-09-07). Every path that refuses a turn — capability not on the plan,
// quota exhausted, credits gone — now persists its refusal as a real
// assistant row (see persistRefusal below), so history alternates properly.
// This function exists in case a future path forgets to.
//
// WHAT WENT WRONG. A user asked "what is the latest news about floods in
// nepal?" and was correctly refused ("Web search isn't available on your
// plan") — but only over SSE; nothing was written for the assistant turn.
// The user's own message row was already persisted, so the next turn's
// history read back as two consecutive user messages:
//
//   user: "what is the latest news about floods in nepal?"   <- orphaned
//   user: "tell few oral histories about mahatma gandhi"
//
// The model, given two questions and no intervening answer, answered BOTH:
// the reply opened with a "Floods in Nepal" section the user had not asked
// for in that turn and had already been told was unavailable.
//
// Collapsing to the LAST of a consecutive user run (rather than dropping
// the run entirely) keeps the turn the user is actually waiting on, which
// is always the most recent one — chat.ts relies on history's last entry
// being exactly that.
export function dropOrphanedUserTurns(messages: HistoryMessage[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const message of messages) {
    if (message.role === "user" && out.length > 0 && out[out.length - 1].role === "user") {
      out[out.length - 1] = message; // supersede the unanswered one
      continue;
    }
    out.push(message);
  }
  return out;
}

// Persists a refusal as a real assistant turn.
//
// Two bugs at once, both seen in production: without this, a refused turn
// left an orphaned user message that bled into the next turn's answer (see
// dropOrphanedUserTurns above), AND the refusal itself vanished on reload —
// the user saw "Web search isn't available on your plan" live, refreshed,
// and found their question sitting there with no reply at all.
//
// status 'failed' is the existing, correct classification: the turn
// genuinely did not produce a generation, and 'failed' rows are already
// specified to carry a short honest string rather than a blank (see this
// file's header). Best-effort by design — a refusal that has already been
// delivered over SSE must never be turned into a 500 because bookkeeping
// failed afterwards.
export async function persistRefusal(
  fastify: FastifyInstance,
  conversationId: string,
  content: string,
): Promise<void> {
  try {
    await insertMessage(fastify, { conversationId, role: "assistant", content, status: "failed" });
  } catch (err) {
    fastify.log.warn({ err, conversationId }, "failed to persist refusal message (non-fatal)");
  }
}

export async function deleteMessageAndAfter(
  fastify: FastifyInstance,
  conversationId: string,
  fromMessageId: string,
): Promise<void> {
  const { data: target, error: targetError } = await fastify.supabaseAdmin
    .from("messages")
    .select("created_at")
    .eq("id", fromMessageId)
    .single();

  if (targetError || !target) return;

  await fastify.supabaseAdmin
    .from("messages")
    .delete()
    .eq("conversation_id", conversationId)
    .gte("created_at", target.created_at as string);
}
