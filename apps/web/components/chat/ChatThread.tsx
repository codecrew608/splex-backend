"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Link2, MoreHorizontal, Trash2, Check } from "lucide-react";
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
  initialTitle?: string;
}

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL as string;

export function ChatThread({
  conversationId: initialConversationId,
  initialMessages,
  projectId,
  initialWorkflow,
  initialTitle,
}: ChatThreadProps) {
  const router = useRouter();
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
  const [copiedLink, setCopiedLink] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

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

  async function handleShare() {
    await navigator.clipboard.writeText(window.location.href);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 1600);
  }

  async function handleDelete() {
    if (!conversationId) return;
    setMenuOpen(false);
    if (!window.confirm("Delete this conversation? This can't be undone.")) return;
    const supabase = createClient();
    await supabase.from("conversations").delete().eq("id", conversationId);
    router.push("/chat");
    router.refresh();
  }

  const lastAssistantMessage = [...messages].reverse().find((m) => m.role === "assistant" && !m.streaming);
  const firstUserMessage = messages.find((m) => m.role === "user");
  const title = initialTitle || firstUserMessage?.content.slice(0, 60) || "New chat";
  const lastMessage = messages[messages.length - 1];
  const titleMeta = lastMessage ? `Updated ${formatTime(lastMessage.createdAt)}` : "New";

  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-[58px] shrink-0 items-center gap-3 border-b border-border px-5">
        <div className="flex min-w-0 flex-1 items-center gap-[11px]">
          <span className="truncate text-[13.5px] font-medium text-foreground">{title}</span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{titleMeta}</span>
        </div>
        {conversationId && (
          <>
            <button
              type="button"
              onClick={handleShare}
              className="flex items-center gap-1.5 rounded-lg border border-border-strong px-[11px] py-[6px] text-[12.5px] font-medium text-foreground transition-colors hover:border-accent hover:text-accent"
            >
              {copiedLink ? <Check size={13} strokeWidth={1.6} /> : <Link2 size={13} strokeWidth={1.6} />}
              {copiedLink ? "Copied" : "Share"}
            </button>
            <div className="relative">
              <button
                type="button"
                onClick={() => setMenuOpen((o) => !o)}
                className="flex h-[30px] w-[30px] items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
              >
                <MoreHorizontal size={16} strokeWidth={1.6} />
              </button>
              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                  <div className="absolute right-0 top-[38px] z-20 w-44 rounded-lg border border-border bg-surface-raised p-1 shadow-[var(--shadow-card)]">
                    <button
                      type="button"
                      onClick={handleDelete}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-[7px] text-left text-[13px] text-danger transition-colors hover:bg-hover"
                    >
                      <Trash2 size={13} strokeWidth={1.6} />
                      Delete conversation
                    </button>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-6 pb-2 pt-[30px]">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-[30px]">
          {messages.length === 0 && (
            <div className="flex animate-fade-in flex-col items-center gap-3 pt-[16vh] text-center">
              <h1 className="text-[31px] font-medium tracking-[-0.025em] text-foreground">Where should we start?</h1>
              <p className="max-w-[400px] text-[14.5px] text-muted-foreground">
                Describe the outcome you want. Cortex handles the rest.
              </p>
            </div>
          )}

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
          <div ref={bottomRef} />
        </div>
      </div>

      <Composer onSend={sendMessage} isStreaming={isStreaming} onStop={stop} />
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
