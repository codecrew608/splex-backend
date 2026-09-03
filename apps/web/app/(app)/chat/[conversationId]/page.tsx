import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ChatThread } from "@/components/chat/ChatThread";
import type { ChatMessage } from "@splex/shared-types";
import type { WorkflowView } from "@/hooks/useChatStream";

interface PageProps {
  params: Promise<{ conversationId: string }>;
}

const ACTIVE_WORKFLOW_STATUSES = ["planning", "awaiting_clarification", "running"];

export default async function ConversationPage({ params }: PageProps) {
  const { conversationId } = await params;
  const supabase = await createClient();

  // RLS (owner-scoped via conversations -> projects join) is the actual
  // authorization gate here — this query simply returns nothing if the
  // conversation isn't this user's.
  const { data: conversation } = await supabase.from("conversations").select("id, title").eq("id", conversationId).single();

  if (!conversation) {
    notFound();
  }

  // credits_charged is deliberately NOT selected — SPLEX credits are an
  // internal backend metering unit, never sent to the client. This was
  // previously fetched and threaded all the way into ChatMessage without
  // ever being rendered anywhere (see MessageCortexDisclosure.tsx's own
  // "credits deliberately absent" comment) — real backend data reaching
  // the browser's RSC payload for a UI element that never displayed it.
  const { data: messageRows } = await supabase
    .from("messages")
    .select("id, conversation_id, role, content, intent, complexity, created_at, status")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  const messageIds = (messageRows ?? []).map((row) => row.id);
  // Display metadata only (filename/mime_type) — never extracted_text or
  // storage_path; RLS (files_owner_all) is the real gate here too, so this
  // simply returns nothing for a file that somehow isn't this user's own.
  // Empty `in()` list short-circuits rather than issuing a query that
  // would otherwise just return everything the filter doesn't exclude.
  const { data: attachmentRows } =
    messageIds.length > 0
      ? await supabase.from("files").select("id, message_id, filename, mime_type").in("message_id", messageIds)
      : { data: [] as Array<{ id: string; message_id: string | null; filename: string; mime_type: string | null }> };

  const attachmentsByMessage = new Map<string, { id: string; filename: string; mimeType: string | null }[]>();
  for (const file of attachmentRows ?? []) {
    if (!file.message_id) continue;
    const list = attachmentsByMessage.get(file.message_id) ?? [];
    list.push({ id: file.id, filename: file.filename, mimeType: file.mime_type });
    attachmentsByMessage.set(file.message_id, list);
  }

  const initialMessages: ChatMessage[] = (messageRows ?? []).map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    intent: row.intent,
    complexity: row.complexity,
    createdAt: row.created_at,
    // A 'streaming' row surviving all the way to this fresh server fetch
    // means whatever tab was generating it is gone (this IS the durable
    // recovery path) — see ChatThread's own handling of this status for
    // what the user sees.
    status: row.status,
    attachments: attachmentsByMessage.get(row.id),
  }));

  // Reload-recovery for a mid-workflow conversation. Same shape as the
  // messages query above: RLS (owner-scoped via workflow_runs ->
  // conversations -> projects) is the real gate, and this query's own
  // column allowlist is the second line of defense — never selects
  // detailed_prompt/routed_model.
  let initialWorkflow: WorkflowView | null = null;
  const { data: workflowRun } = await supabase
    .from("workflow_runs")
    .select("id, status, clarification_question")
    .eq("conversation_id", conversationId)
    .in("status", ACTIVE_WORKFLOW_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (workflowRun) {
    const { data: stepRows } = await supabase
      .from("workflow_steps")
      .select("step_index, title, category_label, status")
      .eq("workflow_run_id", workflowRun.id)
      .order("step_index", { ascending: true });

    initialWorkflow = {
      steps: (stepRows ?? []).map((row) => ({
        title: row.title,
        categoryLabel: row.category_label,
        // A step paused for clarification is stored as
        // "awaiting_clarification" in the DB (see orchestrator.ts) —
        // WorkflowStepView only models the 4 generic states, and visually
        // "in progress, waiting on you" reads the same as "running".
        status: row.status === "awaiting_clarification" ? "running" : (row.status as "pending" | "running" | "completed" | "failed"),
      })),
      clarificationQuestion: workflowRun.clarification_question,
    };
  }

  return (
    // key forces a fresh ChatThread/useChatStream instance per
    // conversation — see the matching comment in /chat/page.tsx for why
    // this is required (shared (app) layout means React would otherwise
    // reuse the same component instance, and its internal state, across
    // navigations between different conversations).
    <ChatThread
      key={conversationId}
      conversationId={conversationId}
      initialMessages={initialMessages}
      initialWorkflow={initialWorkflow}
      initialTitle={conversation.title}
    />
  );
}
