"use client";

import { useCallback, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { streamChat } from "@/lib/chatStream";
import type { ChatMessage, CortexDecisionPayload, CortexStatusStage } from "@/shared-types";
import { useSidebarStore } from "@/state/sidebarStore";

export interface LocalChatMessage extends ChatMessage {
  streaming?: boolean;
  // Attached to the specific assistant message that produced it, not kept
  // as a single session-wide "latest decision" — so each message's own
  // disclosure (MessageCortexDisclosure) still shows the right data after
  // later messages are sent, matching the reference design's per-message
  // Cortex pill instead of one panel that only ever reflects the last turn.
  cortexDecision?: CortexDecisionPayload | null;
  workflowSteps?: WorkflowStepView[] | null;
}

export interface WorkflowStepView {
  title: string;
  categoryLabel: string;
  status: "pending" | "running" | "completed" | "failed";
}

export interface WorkflowView {
  steps: WorkflowStepView[];
  clarificationQuestion: string | null;
}

function emptyMessage(id: string, conversationId: string, role: "user" | "assistant", content: string): LocalChatMessage {
  return {
    id,
    conversationId,
    role,
    content,
    intent: null,
    complexity: null,
    creditsCharged: null,
    createdAt: new Date().toISOString(),
  };
}

export function useChatStream(
  initialConversationId: string | undefined,
  initialMessages: ChatMessage[],
  initialProjectId?: string,
  initialWorkflow: WorkflowView | null = null,
) {
  const upsertConversation = useSidebarStore((s) => s.upsertConversation);

  const [conversationId, setConversationId] = useState<string | undefined>(initialConversationId);
  const [messages, setMessages] = useState<LocalChatMessage[]>(initialMessages);
  const [status, setStatus] = useState<CortexStatusStage | "idle" | "awaiting_clarification">(
    initialWorkflow?.clarificationQuestion ? "awaiting_clarification" : "idle",
  );
  const [statusLabel, setStatusLabel] = useState("");
  const [cortexDecision, setCortexDecision] = useState<CortexDecisionPayload | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowView | null>(initialWorkflow);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // Plain ref, not state — read synchronously right after streamChat()
  // resolves, in the same tick that flips isStreaming off. Avoids a stale
  // closure over "status" inside the onDone handler.
  const doneAwaitingClarification = useRef(false);
  // run() is memoized via useCallback with a deps array that doesn't
  // include `workflow` — so onDone's closure over the plain `workflow`
  // variable would be stale (whatever it was when run() was last
  // reconstructed, not what accumulated via onWorkflowPlan/
  // onWorkflowStepStatus during THIS call). Kept in sync at every
  // setWorkflow call site instead, so onDone can read the true current
  // value synchronously.
  const workflowRef = useRef<WorkflowView | null>(initialWorkflow);
  function updateWorkflow(next: WorkflowView | null | ((prev: WorkflowView | null) => WorkflowView | null)) {
    setWorkflow((prev) => {
      const resolved = typeof next === "function" ? next(prev) : next;
      workflowRef.current = resolved;
      return resolved;
    });
  }

  const run = useCallback(
    async (text: string, regenerateMessageId?: string, fileIds?: string[]) => {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) return;

      setCortexDecision(null);
      updateWorkflow(null);
      setIsStreaming(true);
      setStatus("understanding");
      setStatusLabel("Understanding task...");

      let userLocalId: string | undefined;
      if (regenerateMessageId) {
        setMessages((prev) => prev.filter((m) => m.id !== regenerateMessageId));
      } else {
        userLocalId = crypto.randomUUID();
        setMessages((prev) => [...prev, emptyMessage(userLocalId as string, conversationId ?? "", "user", text)]);
      }

      const assistantLocalId = crypto.randomUUID();
      setMessages((prev) => [
        ...prev,
        { ...emptyMessage(assistantLocalId, conversationId ?? "", "assistant", ""), streaming: true },
      ]);

      const controller = new AbortController();
      abortRef.current = controller;

      await streamChat(
        {
          conversationId,
          message: regenerateMessageId ? undefined : text,
          regenerateMessageId,
          fileIds: regenerateMessageId ? undefined : fileIds,
          // Only meaningful when this is the first message of a brand-new
          // conversation — resolveConversation ignores it otherwise.
          projectId: conversationId ? undefined : initialProjectId,
        },
        session.access_token,
        {
          onConversationCreated: ({ conversationId: newId }) => {
            setConversationId(newId);
            upsertConversation({ id: newId, projectId: "", title: text.slice(0, 60) || "New chat", createdAt: new Date().toISOString() });
            // window.history, NOT router.replace/push: a real Next.js App Router
            // navigation here would swap in a fresh server-rendered /chat/[id]
            // page — remounting this whole component mid-stream and silently
            // dropping every token event that arrives after that point, even
            // though the backend call keeps running and completes/persists
            // successfully (discovered live: the message only appeared after
            // a manual reload). Updating the URL via the History API instead
            // just relabels the address bar — no navigation, no remount, the
            // in-flight stream keeps rendering into this same component.
            window.history.replaceState(null, "", `/chat/${newId}`);
          },
          onCortexStatus: ({ stage, label }) => {
            setStatus(stage);
            setStatusLabel(label);
          },
          onCortexDecision: (decision) => {
            setCortexDecision(decision);
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantLocalId ? { ...m, cortexDecision: decision } : m)),
            );
          },
          onToken: ({ delta }) => {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantLocalId ? { ...m, content: m.content + delta } : m)),
            );
          },
          onError: ({ message }) => {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantLocalId ? { ...m, content: m.content || message, streaming: false } : m)),
            );
          },
          onDone: ({ messageId, userMessageId, awaitingClarification }) => {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id === assistantLocalId) {
                  // Snapshot the live workflow's steps onto this message so
                  // its own disclosure keeps showing them after the next
                  // message starts and clears the top-level `workflow` state.
                  return { ...m, id: messageId ?? m.id, streaming: false, workflowSteps: workflowRef.current?.steps ?? null };
                }
                // Swap the user message's client-generated placeholder id
                // for its real DB id — without this, "Edit" on that message
                // calls the truncate endpoint with an id that matches
                // nothing server-side and silently no-ops.
                if (userLocalId && m.id === userLocalId) return { ...m, id: userMessageId ?? m.id };
                return m;
              }),
            );
            // Authoritative paused signal — not inferred from whether a
            // workflow_clarification event happened to arrive earlier in
            // this stream, which a page reload would lose.
            if (awaitingClarification) doneAwaitingClarification.current = true;
          },
          onWorkflowPlan: ({ steps }) => {
            updateWorkflow({
              steps: steps.map((s) => ({ title: s.title, categoryLabel: s.categoryLabel, status: "pending" })),
              clarificationQuestion: null,
            });
          },
          onWorkflowStepStatus: ({ stepIndex, status: stepStatus, title }) => {
            // Defense in depth: the backend always sends workflow_plan
            // before any workflow_step_status now, but silently dropping
            // a status update just because the plan hasn't arrived yet
            // (previously: `if (!prev) return prev`) is the wrong failure
            // mode — it left the panel blank for an entire resumed run
            // until this was traced back and fixed server-side. Growing
            // the array to fit is a strictly better fallback than losing
            // the update.
            updateWorkflow((prev) => {
              const steps = prev ? [...prev.steps] : [];
              while (steps.length <= stepIndex) {
                steps.push({ title, categoryLabel: "", status: "pending" });
              }
              steps[stepIndex] = { ...steps[stepIndex], title, status: stepStatus };
              return { steps, clarificationQuestion: prev?.clarificationQuestion ?? null };
            });
          },
          onWorkflowClarification: ({ question }) => {
            updateWorkflow((prev) => (prev ? { ...prev, clarificationQuestion: question } : { steps: [], clarificationQuestion: question }));
          },
        },
        controller.signal,
      );

      setIsStreaming(false);
      setStatus(doneAwaitingClarification.current ? "awaiting_clarification" : "idle");
      setStatusLabel("");
      doneAwaitingClarification.current = false;
    },
    [conversationId, initialProjectId, upsertConversation],
  );

  const sendMessage = useCallback((text: string, fileIds?: string[]) => run(text, undefined, fileIds), [run]);
  const regenerate = useCallback((messageId: string) => run("", messageId), [run]);
  const stop = useCallback(() => abortRef.current?.abort(), []);

  return {
    conversationId,
    messages,
    status,
    statusLabel,
    cortexDecision,
    workflow,
    isStreaming,
    sendMessage,
    regenerate,
    stop,
  };
}
