import type { FastifyInstance } from "fastify";
import type { ComplexityLevel, MessageRole } from "@splex/shared-types";

export interface InsertMessageParams {
  conversationId: string;
  role: MessageRole;
  content: string;
  intent?: string;
  complexity?: ComplexityLevel;
  creditsCharged?: number;
  routedModel?: string; // INTERNAL ONLY — real openrouter_model_id.
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
