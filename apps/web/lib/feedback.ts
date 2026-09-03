import { BACKEND_URL } from "./backendUrl";
import { createClient } from "./supabase/client";

export const FEEDBACK_CATEGORIES = [
  { value: "incorrect_answer", label: "Incorrect answer" },
  { value: "bad_reasoning", label: "Bad reasoning" },
  { value: "hallucination", label: "Hallucination" },
  { value: "poor_response", label: "Poor response" },
  { value: "missing_feature", label: "Missing feature" },
  { value: "bug", label: "Bug" },
  { value: "file_image_issue", label: "File/image issue" },
  { value: "other", label: "Other" },
] as const;

export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number]["value"];

export interface SubmitFeedbackInput {
  feedbackType: "thumbs_up" | "thumbs_down";
  conversationId?: string;
  messageId?: string;
  category?: FeedbackCategory;
  comment?: string;
  capabilityLabel?: string;
}

// Server-authoritative persistence (POST /feedback) — never a direct
// client insert; see db/migrations/0039's own comment for why (ownership
// re-verification, safe metadata, the notification email). Resolves to
// false on any failure rather than throwing, so a caller can show "​try
// again" without needing its own try/catch.
export async function submitFeedback(input: SubmitFeedbackInput): Promise<boolean> {
  try {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return false;

    const res = await fetch(`${BACKEND_URL}/feedback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ ...input, appVersion: process.env.NEXT_PUBLIC_APP_VERSION }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
