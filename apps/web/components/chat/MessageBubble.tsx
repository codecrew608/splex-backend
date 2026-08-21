"use client";

import { useState } from "react";
import { Check, Copy, Pencil, RotateCcw } from "lucide-react";
import type { LocalChatMessage } from "@/hooks/useChatStream";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { MessageCortexDisclosure } from "./MessageCortexDisclosure";
import { CitationsList } from "./CitationsList";

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

export function MessageBubble({ message, showRegenerate, onRegenerate, onEditSubmit }: MessageBubbleProps) {
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const isUser = message.role === "user";

  async function handleCopy() {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }

  function handleEditSave() {
    if (draft.trim() && onEditSubmit) {
      onEditSubmit(draft.trim());
    }
    setEditing(false);
  }

  const showActions = hovered && !message.streaming && message.content;

  if (isUser) {
    return (
      <div
        className="flex animate-fade-in-up flex-col items-end gap-[11px]"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
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
          {!editing && showActions && (
            <div className="flex animate-fade-in items-center gap-[2px]">
              <ActionButton onClick={handleCopy} title="Copy" icon={copied ? Check : Copy} label={copied ? "Copied" : "Copy"} />
              {onEditSubmit && <ActionIconButton onClick={() => setEditing(true)} title="Edit" icon={Pencil} />}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex animate-fade-in-up flex-col items-start gap-[11px]"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="flex items-center gap-[9px]">
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
          <path d="M2 1L9.5 6L2 11Z" fill="var(--accent)" />
        </svg>
        <span className="font-mono text-[10.5px] tracking-[0.14em] text-foreground">SPLEX</span>
        <span className="font-mono text-[10px] text-muted-foreground">{formatTime(message.createdAt)}</span>
      </div>

      <MessageCortexDisclosure workflowSteps={message.workflowSteps} />

      <div className="min-w-0 w-full">
        {message.content ? (
          <MarkdownRenderer content={message.content} />
        ) : message.streaming ? (
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
        {showActions && (
          <div className="flex animate-fade-in items-center gap-[2px]">
            <ActionButton onClick={handleCopy} title="Copy" icon={copied ? Check : Copy} label={copied ? "Copied" : "Copy"} />
            {showRegenerate && onRegenerate && <ActionIconButton onClick={onRegenerate} title="Regenerate" icon={RotateCcw} />}
          </div>
        )}
      </div>
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
      className="flex items-center gap-1.5 rounded-md px-[7px] py-1 text-[11.5px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
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
      className="flex h-[26px] w-[26px] items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
    >
      <Icon size={13} strokeWidth={1.4} />
    </button>
  );
}
