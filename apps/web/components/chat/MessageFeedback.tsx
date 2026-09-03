"use client";

import { useState } from "react";
import { ThumbsUp, ThumbsDown, Check } from "lucide-react";
import { submitFeedback, FEEDBACK_CATEGORIES, type FeedbackCategory } from "@/lib/feedback";
import { cn } from "@/lib/cn";

interface MessageFeedbackProps {
  conversationId: string;
  messageId: string;
  // Display label only (e.g. "Web search", "Image generation") — same
  // safe value GET /entitlements already exposes, never a model id.
  capabilityLabel?: string | null;
}

type Vote = "thumbs_up" | "thumbs_down" | null;

// Thumbs up submits immediately — a bare positive signal is useful on its
// own and there's rarely more to add. Thumbs down submits immediately too
// (capturing the signal the moment it happens, matching "feedback
// submitted -> persisted" for the common case where someone reacts and
// moves on) and reveals an optional "tell us more" panel; using it sends
// a second, more detailed row rather than editing the first — feedback
// rows are immutable by design (see migration 0039: no UPDATE grant for
// the client), so an edit-in-place flow isn't an honest option here.
export function MessageFeedback({ conversationId, messageId, capabilityLabel }: MessageFeedbackProps) {
  const [vote, setVote] = useState<Vote>(null);
  const [expanded, setExpanded] = useState(false);
  const [category, setCategory] = useState<FeedbackCategory | "">("");
  const [comment, setComment] = useState("");
  const [detailSent, setDetailSent] = useState(false);
  const [sending, setSending] = useState(false);

  async function handleVote(next: Exclude<Vote, null>) {
    if (vote === next) return; // already recorded this reaction
    setVote(next);
    if (next === "thumbs_down") setExpanded(true);
    await submitFeedback({
      feedbackType: next,
      conversationId,
      messageId,
      capabilityLabel: capabilityLabel ?? undefined,
    });
  }

  async function handleSendDetail() {
    if (!category && !comment.trim()) {
      setExpanded(false);
      return;
    }
    setSending(true);
    const ok = await submitFeedback({
      feedbackType: "thumbs_down",
      conversationId,
      messageId,
      category: category || undefined,
      comment: comment.trim() || undefined,
      capabilityLabel: capabilityLabel ?? undefined,
    });
    setSending(false);
    if (ok) {
      setDetailSent(true);
      setExpanded(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => handleVote("thumbs_up")}
          title="Good response"
          aria-label="Good response"
          aria-pressed={vote === "thumbs_up"}
          className={cn(
            "flex h-[26px] w-[26px] items-center justify-center rounded-md transition-colors",
            vote === "thumbs_up" ? "text-accent" : "text-muted-foreground hover:bg-hover hover:text-foreground",
          )}
        >
          <ThumbsUp size={13} strokeWidth={1.6} fill={vote === "thumbs_up" ? "currentColor" : "none"} />
        </button>
        <button
          type="button"
          onClick={() => handleVote("thumbs_down")}
          title="Bad response"
          aria-label="Bad response"
          aria-pressed={vote === "thumbs_down"}
          className={cn(
            "flex h-[26px] w-[26px] items-center justify-center rounded-md transition-colors",
            vote === "thumbs_down" ? "text-danger" : "text-muted-foreground hover:bg-hover hover:text-foreground",
          )}
        >
          <ThumbsDown size={13} strokeWidth={1.6} fill={vote === "thumbs_down" ? "currentColor" : "none"} />
        </button>
      </div>

      {expanded && !detailSent && (
        <div className="flex max-w-sm flex-col gap-2 rounded-xl border border-border bg-surface p-3">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as FeedbackCategory | "")}
            className="rounded-md border border-border bg-surface-raised px-2 py-1.5 text-xs text-foreground focus:border-accent focus:outline-none"
          >
            <option value="">What went wrong? (optional)</option>
            {FEEDBACK_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="Anything else you'd like to add? (optional)"
            className="resize-none rounded-md border border-border bg-surface-raised p-2 text-xs text-foreground placeholder:text-muted-foreground focus:border-accent focus:outline-none"
          />
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={() => setExpanded(false)} className="text-xs text-muted-foreground hover:text-foreground">
              Dismiss
            </button>
            <button
              type="button"
              onClick={handleSendDetail}
              disabled={sending}
              className="rounded-md bg-accent px-2.5 py-1 text-xs font-semibold text-accent-foreground hover:bg-accent-hover disabled:opacity-50"
            >
              {sending ? "Sending..." : "Send feedback"}
            </button>
          </div>
        </div>
      )}

      {detailSent && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Check size={12} /> Thanks — feedback sent.
        </p>
      )}
    </div>
  );
}
