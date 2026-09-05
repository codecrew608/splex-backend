"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Link2, MoreHorizontal, Trash2, Check, ArrowDown } from "lucide-react";
import type { ChatMessage } from "@/shared-types";
import { useChatStream, type WorkflowView } from "@/hooks/useChatStream";
import { useSidebarStore } from "@/state/sidebarStore";
import { cn } from "@/lib/cn";
import { createClient } from "@/lib/supabase/client";
import { MessageBubble } from "./MessageBubble";
import { CortexRoutingFlow } from "./CortexRoutingFlow";
import { WorkflowPanel } from "./WorkflowPanel";
import { ResearchPanel } from "./ResearchPanel";
import { Composer } from "./Composer";
import { BACKEND_URL } from "@/lib/backendUrl";

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
    researchStage,
    isStreaming,
    sendMessage,
    regenerate,
    stop,
  } = useChatStream(initialConversationId, initialMessages, projectId, initialWorkflow ?? null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // "Jump to latest" affordance: invisible while the conversation already
  // fits on screen or the user is already at the bottom (nothing to jump
  // to), visible once they've scrolled up far enough that the newest
  // content is genuinely out of view — e.g. scrolled up to re-read
  // something while a long answer is still streaming in below.
  const [showScrollButton, setShowScrollButton] = useState(false);
  // SidebarReopenButton is position:fixed at left-3/top-3 and only exists
  // while the sidebar is closed — which put it directly on top of this
  // header's title (reported live: the chat name renders underneath the
  // hamburger). Reserving the space here, rather than making the button
  // in-flow, keeps the header's bottom border spanning the full width and
  // costs nothing while the sidebar is open. Matters most on mobile, where
  // the sidebar defaults to closed on every load.
  const sidebarOpen = useSidebarStore((s) => s.open);

  useEffect(() => {
    // Don't yank the user back down if they've deliberately scrolled up to
    // re-read something while a response is still streaming in below —
    // only auto-follow while they're already at (or near) the bottom.
    if (!showScrollButton) bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, statusLabel, showScrollButton]);

  // 120px: enough slack that the button doesn't flicker on tiny sub-pixel
  // scroll deltas right at the bottom, small enough that it still shows up
  // promptly once the user has genuinely scrolled away from the latest
  // content.
  const NEAR_BOTTOM_THRESHOLD_PX = 120;

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    function updateFromScrollPosition() {
      if (!el) return;
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowScrollButton(distanceFromBottom > NEAR_BOTTOM_THRESHOLD_PX);
    }

    updateFromScrollPosition();
    el.addEventListener("scroll", updateFromScrollPosition, { passive: true });
    // Content growing while streaming in (no scroll event fires for that on
    // its own) can also change whether the user is "near the bottom" —
    // re-check on every render this effect's own deps change, not just on
    // an actual scroll gesture.
    return () => el.removeEventListener("scroll", updateFromScrollPosition);
  }, [messages, statusLabel]);

  function scrollToBottom() {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }

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
    <div className="flex h-dvh flex-col">
      <header
        className={cn(
          "flex h-[58px] shrink-0 items-center gap-2 border-b border-border px-3 sm:gap-3 sm:px-5",
          !sidebarOpen && "pl-[52px]",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-[11px]">
          <span className="truncate text-[13.5px] font-medium text-foreground">{title}</span>
          {/* "Updated 14:32" is the first thing worth dropping on a narrow
              screen — it competes with the title for the same row and the
              title is what identifies the chat. */}
          <span className="hidden shrink-0 font-mono text-[10px] text-muted-foreground sm:inline">{titleMeta}</span>
        </div>
        {conversationId && (
          <>
            <button
              type="button"
              onClick={handleShare}
              title={copiedLink ? "Link copied" : "Copy link to this chat"}
              // The visible label is hidden below sm, so without this the
              // control is announced as just "button" on a phone.
              aria-label={copiedLink ? "Link copied" : "Copy link to this chat"}
              className="flex h-11 shrink-0 items-center gap-1.5 rounded-lg border border-border-strong px-3 text-[12.5px] font-medium text-foreground transition-colors hover:border-accent hover:text-accent sm:h-auto sm:px-[11px] sm:py-[6px]"
            >
              {copiedLink ? <Check size={13} strokeWidth={1.6} /> : <Link2 size={13} strokeWidth={1.6} />}
              {/* Icon-only below sm — the label is the widest thing in this
                  header and the icon already carries the meaning. */}
              <span className="hidden sm:inline">{copiedLink ? "Copied" : "Share"}</span>
            </button>
            <div className="relative">
              <button
                type="button"
                onClick={() => setMenuOpen((o) => !o)}
                // Icon-only at every breakpoint — it had no accessible name
                // whatsoever before, announcing as an unlabelled "button".
                aria-label="Conversation options"
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                title="Conversation options"
                className="flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-hover hover:text-foreground sm:h-[30px] sm:w-[30px]"
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

      {messages.length === 0 ? (
        // Empty new chat: composer sits centered in the viewport, ChatGPT-style,
        // rather than docked at the bottom — there's nothing above it to scroll to
        // yet. It drops back into the normal bottom-docked position (the branch
        // below) as soon as the first message lands, since `messages` flips this
        // ternary on the very next render.
        <div className="flex flex-1 flex-col items-center justify-center px-3 pb-[6vh] sm:px-6 sm:pb-[8vh]">
          <div className="mb-6 flex animate-fade-in flex-col items-center gap-3 text-center sm:mb-8">
            <h1 className="text-[25px] font-medium tracking-[-0.025em] text-foreground sm:text-[31px]">
              Where should we start?
            </h1>
            <p className="max-w-[400px] text-[13.5px] text-muted-foreground sm:text-[14.5px]">
              Describe the outcome you want. Cortex handles the rest.
            </p>
          </div>
          <Composer onSend={sendMessage} isStreaming={isStreaming} onStop={stop} />
        </div>
      ) : (
        <>
          <div className="relative flex-1 min-h-0">
            <div ref={scrollContainerRef} className="h-full overflow-y-auto px-3 pb-2 pt-5 sm:px-6 sm:pt-[30px]">
            <div className="mx-auto flex w-full max-w-[720px] flex-col gap-[30px]">
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

              {researchStage ? (
                <ResearchPanel currentStage={researchStage} />
              ) : workflow ? (
                <WorkflowPanel workflow={workflow} />
              ) : (
                <CortexRoutingFlow
                  status={status === "awaiting_clarification" ? "idle" : status}
                  statusLabel={statusLabel}
                  isStreaming={isStreaming}
                  // categoryLabel is what Cortex resolved the request to
                  // (e.g. "Coding"); it lands with the decision event, which
                  // is the first moment there's anything true to show about
                  // where this is being routed.
                  modelDisplayName={cortexDecision?.categoryLabel ?? null}
                />
              )}
              <div ref={bottomRef} />
            </div>
            </div>

            {showScrollButton && (
              <button
                type="button"
                onClick={scrollToBottom}
                aria-label="Scroll to latest message"
                title="Scroll to latest message"
                className="absolute bottom-3 left-1/2 flex h-9 w-9 -translate-x-1/2 animate-fade-in items-center justify-center rounded-full border border-border-strong bg-surface-raised text-foreground shadow-[var(--shadow-card)] transition-colors hover:border-accent hover:text-accent"
              >
                <ArrowDown size={16} strokeWidth={1.8} />
              </button>
            )}
          </div>

          <Composer onSend={sendMessage} isStreaming={isStreaming} onStop={stop} />
        </>
      )}
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
