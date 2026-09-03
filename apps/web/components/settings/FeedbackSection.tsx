"use client";

import { useState } from "react";
import { submitFeedback, FEEDBACK_CATEGORIES, type FeedbackCategory } from "@/lib/feedback";
import { Button } from "@/components/ui/Button";

// General product feedback, not tied to any specific message — the
// Settings-level counterpart to the per-message thumbs widget in
// MessageBubble (components/chat/MessageFeedback.tsx), which shares the
// same submitFeedback() call and the same server-side persistence
// (POST /feedback, db/migrations/0039).
export function FeedbackSection() {
  const [type, setType] = useState<"thumbs_up" | "thumbs_down">("thumbs_up");
  const [category, setCategory] = useState<FeedbackCategory | "">("");
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit() {
    setSending(true);
    const ok = await submitFeedback({
      feedbackType: type,
      category: category || undefined,
      comment: comment.trim() || undefined,
    });
    setSending(false);
    if (ok) {
      setSent(true);
      setComment("");
      setCategory("");
      setTimeout(() => setSent(false), 4000);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setType("thumbs_up")}
          className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
            type === "thumbs_up" ? "border-accent bg-accent-soft text-accent" : "border-border text-muted-foreground hover:border-border-strong"
          }`}
        >
          👍 Something's good
        </button>
        <button
          type="button"
          onClick={() => setType("thumbs_down")}
          className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
            type === "thumbs_down" ? "border-danger bg-danger/10 text-danger" : "border-border text-muted-foreground hover:border-border-strong"
          }`}
        >
          👎 Something's wrong
        </button>
      </div>

      <select
        value={category}
        onChange={(e) => setCategory(e.target.value as FeedbackCategory | "")}
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none"
      >
        <option value="">Category (optional)</option>
        {FEEDBACK_CATEGORIES.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>

      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={3}
        maxLength={2000}
        placeholder="Tell us more (optional)"
        className="w-full resize-none rounded-lg border border-border bg-surface p-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-accent focus:outline-none"
      />

      <div className="flex items-center gap-3">
        <Button onClick={handleSubmit} disabled={sending}>
          {sending ? "Sending..." : "Send feedback"}
        </Button>
        {sent && <span className="text-sm text-muted-foreground">Thanks — we got it.</span>}
      </div>
    </div>
  );
}
