"use client";

import { useState } from "react";
import { Check, Copy, Pencil, RotateCcw } from "lucide-react";
import type { LocalChatMessage } from "@/hooks/useChatStream";
import { LogoMark } from "@/components/ui/Logo";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { cn } from "@/lib/cn";

interface MessageBubbleProps {
  message: LocalChatMessage;
  showRegenerate?: boolean;
  onRegenerate?: () => void;
  onEditSubmit?: (newContent: string) => void;
}

export function MessageBubble({ message, showRegenerate, onRegenerate, onEditSubmit }: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const isUser = message.role === "user";

  async function handleCopy() {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function handleEditSave() {
    if (draft.trim() && onEditSubmit) {
      onEditSubmit(draft.trim());
    }
    setEditing(false);
  }

  if (isUser) {
    return (
      <div className="group flex animate-fade-in-up justify-end">
        <div className="max-w-[75%]">
          {editing ? (
            <div className="rounded-[22px] border border-border bg-surface p-3">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={Math.min(8, Math.max(2, draft.split("\n").length))}
                className="w-full resize-none bg-transparent text-sm text-foreground focus:outline-none"
                autoFocus
              />
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setDraft(message.content);
                  }}
                  className="rounded-full px-2.5 py-1 text-xs text-muted-foreground hover:bg-surface-raised"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleEditSave}
                  className="rounded-full bg-accent px-2.5 py-1 text-xs font-semibold text-accent-foreground hover:bg-accent-hover"
                >
                  Save & submit
                </button>
              </div>
            </div>
          ) : (
            <div className="rounded-[22px] bg-accent px-4 py-2.5 text-sm text-accent-foreground shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
              {message.content}
            </div>
          )}

          {!editing && (
            <div className="mt-1 flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
              {onEditSubmit && (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-surface-raised hover:text-foreground"
                  title="Edit"
                >
                  <Pencil size={12} />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="group flex animate-fade-in-up items-start gap-2.5">
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center">
        <LogoMark size={22} />
      </div>
      <div className="min-w-0 max-w-[85%] flex-1">
        <div className="rounded-[22px] bg-surface px-4 py-2.5">
          {message.content ? (
            <MarkdownRenderer content={message.content} />
          ) : message.streaming ? (
            <span className="inline-flex gap-1.5 py-1">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.3s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.15s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent" />
            </span>
          ) : null}
        </div>

        {!message.streaming && message.content && (
          <div className="mt-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              type="button"
              onClick={handleCopy}
              className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-surface-raised hover:text-foreground"
              title="Copy"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
            {showRegenerate && onRegenerate && (
              <button
                type="button"
                onClick={onRegenerate}
                className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-surface-raised hover:text-foreground"
                title="Regenerate"
              >
                <RotateCcw size={12} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
