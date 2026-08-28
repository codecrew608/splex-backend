import { z } from "zod";
import { runChat, chatBodySchema, truncateBodySchema } from "../../handlers/chat.js";
import { deleteMessageAndAfter } from "../../persistence/messages.js";
import { cancelActiveWorkflow } from "../../cortex/workflow/orchestrator.js";
import type { WorkerCtx } from "../context.js";
import { asFastifyInstance } from "../context.js";
import type { AuthedUser } from "../../types/index.js";
import { createSSEStream } from "../sse.js";
import { errorResponse, jsonResponse } from "../http.js";

// HTTP adapter only. All chat orchestration lives in handlers/chat.ts,
// shared verbatim with routes/chat.ts — the two previously held 81
// identical operations each, and had already drifted (a latency fix landed
// in this copy but not the Fastify one).

// Entry point called by the router. Validates + parses the body first
// (plain JSON error response, same as the Fastify original returning
// before ever touching the SSE writer) and only opens the SSE stream once
// that passes. The actual chat logic runs via execCtx.waitUntil() —
// necessary because the Response (wrapping the stream) is returned
// immediately so the client starts receiving events right away, while
// runChat keeps writing to it in the background; without waitUntil the
// Workers runtime could tear the isolate down before that finishes.
export async function handleChatRequest(request: Request, ctx: WorkerCtx, user: AuthedUser, execCtx: ExecutionContext): Promise<Response> {
  const parsed = chatBodySchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) {
    return errorResponse("Invalid request.", 400);
  }
  const body = parsed.data;
  if (body.regenerateMessageId && !body.conversationId) {
    return errorResponse("conversationId is required to regenerate.", 400);
  }

  const abortController = new AbortController();
  const { writer, response } = createSSEStream(() => abortController.abort());

  // Per-request COPY, never a mutation of the shared ctx: two concurrent
  // requests would otherwise overwrite each other's ExecutionContext and
  // hand background work to the wrong (possibly already-finished) request.
  const requestCtx: WorkerCtx = { ...ctx, scheduleBackground: (work) => execCtx.waitUntil(work) };
  // waitUntil is how a Worker keeps post-response work alive; the shared
  // orchestration takes it as ScheduleBackground so Node can pass its own.
  execCtx.waitUntil(
    runChat(asFastifyInstance(requestCtx), writer, user, body, abortController, (work) => execCtx.waitUntil(work)),
  );
  return response;
}

export async function handleTruncateMessage(messageIdParam: string, request: Request, ctx: WorkerCtx, user: AuthedUser): Promise<Response> {
  const messageIdParsed = z.string().uuid().safeParse(messageIdParam);
  const body = truncateBodySchema.safeParse(await request.json().catch(() => undefined));
  if (!messageIdParsed.success || !body.success) {
    return errorResponse("Invalid request.", 400);
  }

  const { data: conversation, error } = await ctx.supabaseAdmin
    .from("conversations")
    .select("id, projects!inner(user_id)")
    .eq("id", body.data.conversationId)
    .single();

  if (error || !conversation || (conversation as unknown as { projects: { user_id: string } }).projects.user_id !== user.id) {
    return errorResponse("Conversation not found.", 404);
  }

  const fastify = asFastifyInstance(ctx);
  await cancelActiveWorkflow(fastify, body.data.conversationId);
  await deleteMessageAndAfter(fastify, body.data.conversationId, messageIdParsed.data);
  return new Response(null, { status: 204 });
}
