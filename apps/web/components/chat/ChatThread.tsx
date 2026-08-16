"use client";

import { useEffect, useRef } from "react";
import { Bug, FileText, Lightbulb, ListTree } from "lucide-react";
import type { ChatMessage } from "@splex/shared-types";
import { useChatStream, type WorkflowView } from "@/hooks/useChatStream";
import { createClient } from "@/lib/supabase/client";
import { MessageBubble } from "./MessageBubble";
import { CortexStatusPanel } from "./CortexStatusPanel";
import { WorkflowPanel } from "./WorkflowPanel";
import { Composer } from "./Composer";

interface ChatThreadProps {
  conversationId?: string;
  initialMessages: ChatMessage[];
  // Only meaningful for a brand-new chat with no conversationId yet —
  // attaches it to an existing project instead of creating a fresh one.
  projectId?: string;
  // Reload-recovery: a workflow that was mid-run when the page loaded.
  initialWorkflow?: WorkflowView | null;
}

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL as string;

const SUGGESTIONS = [
  { icon: Bug, label: "Debug a tricky bug", prompt: "Help me debug an issue in my code — I'll paste it below." },
  { icon: FileText, label: "Summarize a document", prompt: "Summarize the key points of a document I'll share." },
  { icon: ListTree, label: "Plan a project roadmap", prompt: "Help me plan a roadmap for a new project." },
  { icon: Lightbulb, label: "Explain a concept simply", prompt: "Explain a complex concept to me in simple terms." },
];

export function ChatThread({
  conversationId: initialConversationId,
  initialMessages,
  projectId,
  initialWorkflow,
}: ChatThreadProps) {
  // conversationId here is useChatStream's LIVE state, not the initial prop
  // above — for a brand-new chat, the prop stays permanently undefined for
  // this component's whole lifetime (the URL updates via history.replaceState,
  // not a real Next.js navigation, so this component never re-renders with a
  // fresh prop). Using the stale prop here meant "Edit" on any message sent
  // in a freshly-created, not-yet-reloaded conversation silently no-oped —
  // the truncate call never even fired.
  const {
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
  } = useChatStream(initialConversationId, initialMessages, projectId, initialWorkflow ?? null);

  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, statusLabel]);

  async function handleEditSubmit(messageId: string, newContent: string) {
    if (!conversationId) return;
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return;

    await fetch(`${BACKEND_URL}/chat/messages/${messageId}/truncate`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ conversationId }),
    });

    sendMessage(newContent);
  }

  const lastAssistantMessage = [...messages].reverse().find((m) => m.role === "assistant" && !m.streaming);

  if (messages.length === 0) {
    return (
      <div className="relative flex h-screen flex-col overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-[8%] h-[420px] w-[640px] -translate-x-1/2 rounded-full opacity-50 blur-[110px]"
          style={{ background: "radial-gradient(circle, var(--accent-glow), transparent 70%)" }}
        />
        <div className="relative flex flex-1 flex-col items-center justify-center px-4">
          <h1 className="animate-fade-in-up text-center text-4xl font-bold tracking-[-0.035em] text-foreground sm:text-5xl">
            What <span className="rounded-lg bg-accent-soft px-2 text-accent">outcome</span> do you need?
          </h1>
          <p className="mt-3 max-w-md text-center text-sm text-muted-foreground animate-fade-in-up [animation-delay:80ms]">
            Describe your goal. SPLEX figures out the rest — no models to choose, nothing to configure.
          </p>

          <div className="mt-8 grid w-full max-w-xl grid-cols-1 gap-2 animate-fade-in-up [animation-delay:160ms] sm:grid-cols-2">
            {SUGGESTIONS.map(({ icon: Icon, label, prompt }) => (
              <button
                key={label}
                type="button"
                onClick={() => sendMessage(prompt)}
                className="group flex items-center gap-2.5 rounded-[22px] border border-border bg-surface px-3.5 py-2.5 text-left text-sm text-foreground transition-all hover:-translate-y-0.5 hover:border-border-strong hover:shadow-[0_10px_24px_-12px_rgba(0,0,0,0.18)] active:scale-[0.98]"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
                  <Icon size={14} strokeWidth={1.75} />
                </span>
                <span className="truncate">{label}</span>
              </button>
            ))}
          </div>
        </div>
        <Composer onSend={sendMessage} isStreaming={isStreaming} onStop={stop} />
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto py-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4">
          {messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              showRegenerate={message.id === lastAssistantMessage?.id}
              onRegenerate={message.id === lastAssistantMessage?.id ? () => regenerate(message.id) : undefined}
              onEditSubmit={
                message.role === "user" ? (newContent) => handleEditSubmit(message.id, newContent) : undefined
              }
            />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="space-y-2 pb-1">
        {workflow ? (
          <WorkflowPanel workflow={workflow} />
        ) : (
          <CortexStatusPanel
            status={status === "awaiting_clarification" ? "idle" : status}
            statusLabel={statusLabel}
            decision={cortexDecision}
            isStreaming={isStreaming}
          />
        )}
        <Composer onSend={sendMessage} isStreaming={isStreaming} onStop={stop} />
      </div>
    </div>
  );
}
