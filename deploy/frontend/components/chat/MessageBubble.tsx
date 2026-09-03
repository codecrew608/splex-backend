"use client";

import { useState } from "react";
import { Check, Copy, Pencil, RotateCcw } from "lucide-react";
import type { LocalChatMessage } from "@/hooks/useChatStream";
import { cn } from "@/lib/cn";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { MessageCortexDisclosure } from "./MessageCortexDisclosure";
import { CitationsList } from "./CitationsList";
import { AttachmentChip } from "./AttachmentChip";
import { MessageFeedback } from "./MessageFeedback";

interface MessageBubbleProps {
  message: LocalChatMessage;
  showRegenerate?: boolean;
  onRegenerate?: () => void;
  onEditSubmit?: (newContent: string) => void;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// Reveals the action row on real hover OR keyboard focus (unchanged desktop
// behavior — same opacity/focus-within pattern already used for the
// sidebar's per-row delete control), PLUS unconditionally on any device
// that can't hover at all. `hover: none` is the standard media feature for
// "touch/coarse-pointer, no mouse" — relying on onMouseEnter/onMouseLeave
// alone (the previous implementation) never fires from a tap on most
// mobile browsers, so Copy/Edit/Regenerate were only ever reachable with a
// mouse. Applied on the wrapping "group" via CSS, not JS state, so it also
// fixes keyboard reachability for free: opacity:0 (unlike display:none)
// never removes a button from the tab order, so a keyboard user can always
// Tab onto it even before group-focus-within reveals it.
const ACTIONS_REVEAL =
  "opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100";

export function MessageBubble({ message, showRegenerate, onRegenerate, onEditSubmit }: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const isUser = message.role === "user";

  async function handleCopy() {
    // navigator.clipboard is undefined outside a secure context (plain
    // http, or an embedded/older webview) and writeText() can also reject
    // (permission denied) — previously nothing caught either case, so a
    // failure left the button silently stuck with no "Copied" feedback and
    // an unhandled rejection. document.execCommand is deprecated but still
    // the only fallback that works where the async API doesn't; both paths
    // fail closed into the same no-feedback state rather than throwing.
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(message.content);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = message.content;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Nothing further to do — the button just doesn't flip to "Copied".
    }
  }

  function handleEditSave() {
    if (draft.trim() && onEditSubmit) {
      onEditSubmit(draft.trim());
    }
    setEditing(false);
  }

  // A message freshly loaded from the server (not this tab's own live
  // stream) can still have status:'streaming' with empty content — either
  // a generation genuinely still running elsewhere (another tab, or this
  // one before ChatThread's reconciliation poll catches up), or, rarely,
  // a row an unexpected server-side failure never finalized. Either way,
  // "still working" is the honest thing to show, same as the live
  // message.streaming flag — never a blank area with nothing in it.
  const isPending = message.streaming || message.status === "streaming";
  const canShowActions = !isPending && Boolean(message.content);

  if (isUser) {
    return (
      <div className="group flex animate-fade-in-up flex-col items-end gap-[11px]">
        {message.attachments && message.attachments.length > 0 && !editing && (
          <div className="flex max-w-[86%] flex-wrap justify-end gap-2">
            {message.attachments.map((a) => (
              <AttachmentChip key={a.id} attachment={{ filename: a.filename, mimeType: a.mimeType }} />
            ))}
          </div>
        )}
        <div className="max-w-[86%]">
          {editing ? (
            <div className="rounded-xl border border-border bg-surface p-3">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={Math.min(8, Math.max(2, draft.split("\n").length))}
                className="w-full resize-none bg-transparent text-[15px] text-foreground focus:outline-none"
                autoFocus
              />
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setDraft(message.content);
                  }}
                  className="rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-hover"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleEditSave}
                  className="rounded-md bg-accent px-2.5 py-1 text-xs font-semibold text-accent-foreground hover:bg-accent-hover"
                >
                  Save & submit
                </button>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-surface px-[17px] py-[13px] text-[15px] leading-[1.68] text-foreground">
              {message.content}
            </div>
          )}
        </div>

        <div className="flex min-h-[24px] items-center gap-[2px]">
          {!editing && canShowActions && (
            <div className={cn("flex items-center gap-[2px]", ACTIONS_REVEAL)}>
              <ActionButton onClick={handleCopy} title="Copy" icon={copied ? Check : Copy} label={copied ? "Copied" : "Copy"} />
              {onEditSubmit && <ActionIconButton onClick={() => setEditing(true)} title="Edit" icon={Pencil} />}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="group flex animate-fade-in-up flex-col items-start gap-[11px]">
      <div className="flex items-center gap-[9px]">
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
          <path d="M2 1L9.5 6L2 11Z" fill="var(--accent)" />
        </svg>
        <span className="font-mono text-[10.5px] tracking-[0.14em] text-foreground">SPLEX</span>
        <span className="font-mono text-[10px] text-muted-foreground">{formatTime(message.createdAt)}</span>
      </div>

      <MessageCortexDisclosure
        workflowSteps={message.workflowSteps}
        cortexVersion={message.cortexVersion}
        routing={message.routing}
      />

      <div className="min-w-0 w-full">
        {message.content ? (
          <MarkdownRenderer content={message.content} />
        ) : isPending ? (
          <span className="inline-flex gap-1.5 py-1">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.3s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.15s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent" />
          </span>
        ) : null}
        {message.streaming && message.content && (
          <span className="mt-[-8px] inline-block h-[15px] w-[7px] animate-blink bg-accent align-text-bottom" />
        )}
        {!message.streaming && message.citations && message.citations.length > 0 && (
          <div className="mt-3">
            <CitationsList citations={message.citations} />
          </div>
        )}
      </div>

      <div className="flex min-h-[24px] items-center gap-[2px]">
        {canShowActions && (
          <div className={cn("flex items-center gap-[2px]", ACTIONS_REVEAL)}>
            <ActionButton onClick={handleCopy} title="Copy" icon={copied ? Check : Copy} label={copied ? "Copied" : "Copy"} />
            {showRegenerate && onRegenerate && <ActionIconButton onClick={onRegenerate} title="Regenerate" icon={RotateCcw} />}
          </div>
        )}
      </div>
      {/* Not hover-gated (unlike the actions row above): once a vote is
          cast, or the detail panel is open, it must stay visible rather
          than vanish the moment the pointer moves away. */}
      {canShowActions && message.conversationId && (
        <MessageFeedback conversationId={message.conversationId} messageId={message.id} capabilityLabel={message.routing?.categoryLabel ?? undefined} />
      )}
    </div>
  );
}

function ActionButton({
  onClick,
  title,
  icon: Icon,
  label,
}: {
  onClick: () => void;
  title: string;
  icon: typeof Copy;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="flex items-center gap-1.5 rounded-md px-[7px] py-1 text-[11.5px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground focus-visible:opacity-100"
    >
      <Icon size={13} strokeWidth={1.4} />
      {label}
    </button>
  );
}

function ActionIconButton({ onClick, title, icon: Icon }: { onClick: () => void; title: string; icon: typeof Copy }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="flex h-[26px] w-[26px] items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground focus-visible:opacity-100"
    >
      <Icon size={13} strokeWidth={1.4} />
    </button>
  );
}
