import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type HandlerResult, ok, fail } from "./result.js";
import { sendEmail } from "../email/sendEmail.js";
import type { AuthedUser } from "../types/index.js";
import type { ScheduleBackground } from "./chat.js";

export const FEEDBACK_CATEGORIES = [
  "incorrect_answer",
  "bad_reasoning",
  "hallucination",
  "poor_response",
  "missing_feature",
  "bug",
  "file_image_issue",
  "other",
] as const;

export const feedbackBodySchema = z.object({
  feedbackType: z.enum(["thumbs_up", "thumbs_down"]),
  conversationId: z.string().uuid().optional(),
  messageId: z.string().uuid().optional(),
  category: z.enum(FEEDBACK_CATEGORIES).optional(),
  // Generous but bounded — matches the column's own check constraint
  // (migration 0039), enforced again here so a bad request 400s with a
  // clear message instead of failing opaquely at the database layer.
  comment: z.string().trim().max(2000).optional(),
  // Display-only capability label the client already has on hand (e.g.
  // "Web search", "Image generation") — never a model id or cost. Purely
  // informational context for whoever reads the notification email; the
  // stored row is authoritative regardless of what this says.
  capabilityLabel: z.string().max(100).optional(),
  appVersion: z.string().max(50).optional(),
});

export type FeedbackBody = z.infer<typeof feedbackBodySchema>;

// Re-verifies ownership server-side rather than trusting the client's
// conversationId/messageId at face value — same "never trust client-
// supplied ids without re-scoping to the caller" rule as fetchOwnedFiles
// (files/attachments.ts). A mismatched or someone-else's id is silently
// dropped (feedback still saves, just without that association) rather
// than rejecting the whole submission over an optional field.
async function verifyOwnership(
  fastify: FastifyInstance,
  userId: string,
  conversationId: string | undefined,
  messageId: string | undefined,
): Promise<{ conversationId: string | null; messageId: string | null }> {
  if (!conversationId) return { conversationId: null, messageId: null };

  const { data: convo } = await fastify.supabaseAdmin.from("conversations").select("project_id").eq("id", conversationId).maybeSingle();
  if (!convo) return { conversationId: null, messageId: null };

  const { data: project } = await fastify.supabaseAdmin.from("projects").select("user_id").eq("id", convo.project_id as string).maybeSingle();
  if (!project || project.user_id !== userId) return { conversationId: null, messageId: null };

  if (!messageId) return { conversationId, messageId: null };

  const { data: message } = await fastify.supabaseAdmin
    .from("messages")
    .select("id")
    .eq("id", messageId)
    .eq("conversation_id", conversationId)
    .maybeSingle();

  return { conversationId, messageId: message ? messageId : null };
}

// Order matters and is the whole point: persist first, notify second, and
// never let the second step affect the first. A feedback submission must
// succeed even when email delivery is down, misconfigured, or simply
// unset (see email/sendEmail.ts — no provider is configured in this
// project by default). scheduleBackground is the same mechanism chat.ts
// uses for memory extraction, for the identical reason: on the Workers
// runtime, an un-awaited promise can be torn down mid-flight the moment
// this function returns unless it's registered with execCtx.waitUntil()
// (see ScheduleBackground's own doc comment in handlers/chat.ts).
export async function submitFeedback(
  fastify: FastifyInstance,
  user: AuthedUser,
  body: FeedbackBody,
  scheduleBackground: ScheduleBackground,
): Promise<HandlerResult<{ id: string }>> {
  const { conversationId, messageId } = await verifyOwnership(fastify, user.id, body.conversationId, body.messageId);

  const { data, error } = await fastify.supabaseAdmin
    .from("feedback")
    .insert({
      user_id: user.id,
      conversation_id: conversationId,
      message_id: messageId,
      feedback_type: body.feedbackType,
      category: body.category ?? null,
      comment: body.comment || null,
      capability_label: body.capabilityLabel ?? null,
      app_version: body.appVersion ?? null,
    })
    .select("id")
    .single();

  if (error || !data) {
    fastify.log.error({ error }, "failed to persist feedback");
    return fail("Could not submit feedback. Please try again.", 500);
  }

  const feedbackId = data.id as string;

  // Fire-and-forget, after persistence has already succeeded — a failure
  // anywhere in here (network, provider down, unset API key) never
  // reaches the client, which has already been told the feedback was
  // saved (it was, by this point). See sendEmail's own doc comment.
  scheduleBackground(
    (async () => {
      const lines = [
        `${body.feedbackType === "thumbs_up" ? "👍" : "👎"} New SPLEX feedback`,
        "",
        `From: ${user.email}`,
        body.category ? `Category: ${body.category}` : "",
        body.capabilityLabel ? `Capability: ${body.capabilityLabel}` : "",
        conversationId ? `Conversation: ${conversationId}` : "",
        messageId ? `Message: ${messageId}` : "",
        body.appVersion ? `App version: ${body.appVersion}` : "",
        "",
        body.comment ? `Comment:\n${body.comment}` : "(no comment)",
      ].filter((l) => l !== "");

      // Recipient is server-side config, never echoed to the client in
      // this function's return value or anywhere in routes/feedback.ts.
      await sendEmail(fastify, {
        to: fastify.config.FEEDBACK_NOTIFICATION_EMAIL,
        subject: `SPLEX feedback: ${body.feedbackType === "thumbs_up" ? "👍" : "👎"}${body.category ? ` (${body.category})` : ""}`,
        text: lines.join("\n"),
      });
    })(),
  );

  return ok({ id: feedbackId }, 201);
}
