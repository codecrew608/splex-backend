import type { FastifyInstance } from "fastify";
import type { ComplexityLevel, MessageRole } from "@splex/shared-types";

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

  return (data as Array<{ role: MessageRole; content: string }>).reverse();
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
