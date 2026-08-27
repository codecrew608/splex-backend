import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { runChat, chatBodySchema, truncateBodySchema } from "../handlers/chat.js";
import { RATE_LIMITS } from "../handlers/rateLimits.js";
import { deleteMessageAndAfter } from "../persistence/messages.js";
import { cancelActiveWorkflow } from "../cortex/workflow/orchestrator.js";
import { SplexSSEWriter } from "../sse/writer.js";

// HTTP adapter only. All chat orchestration lives in handlers/chat.ts,
// shared verbatim with the Worker entry point (worker/routes/chat.ts).
//
// Those two files previously held 81 identical operations each and HAD
// already drifted: a latency fix (starting classification in parallel with
// the context fetch) landed in the Worker copy and never reached this one.
// Sharing the orchestration is what makes that class of divergence
// impossible rather than merely unlikely.
const truncateParamsSchema = z.object({ messageId: z.string().uuid() });

const chatRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    "/chat",
    {
      preHandler: [
        fastify.authenticate,
        fastify.rateLimitByUser("chat", RATE_LIMITS.chat.max, RATE_LIMITS.chat.windowMs),
      ],
    },
    async (request, reply) => {
      const parsed = chatBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ message: "Invalid request." });
      }
      const body = parsed.data;
      if (body.regenerateMessageId && !body.conversationId) {
        return reply.code(400).send({ message: "conversationId is required to regenerate." });
      }

      const sse = new SplexSSEWriter(reply);
      const abortController = new AbortController();
      request.raw.on("close", () => {
        if (!reply.raw.writableEnded) abortController.abort();
      });

      // Node keeps the process alive on its own, so a floating promise is
      // sufficient here — unlike Workers, where the same pattern let the
      // runtime tear the isolate down mid-extraction (see the
      // ScheduleBackground doc comment in handlers/chat.ts).
      await runChat(fastify, sse, request.user, body, abortController, (work) => {
        // Node keeps the process alive on its own, so simply letting the
        // promise run is sufficient. The .catch() is belt-and-braces: the
        // only current background task swallows its own errors, but an
        // unhandled rejection here would take the whole process down under
        // Node's default policy, and a bookkeeping failure must never do
        // that to a server that has already answered the user.
        void work.catch((err: unknown) => {
          fastify.log.warn({ err }, "background task failed after response (non-fatal)");
        });
      });
    },
  );

  fastify.delete(
    "/chat/messages/:messageId/truncate",
    {
      preHandler: [
        fastify.authenticate,
        fastify.rateLimitByUser("chat_truncate", RATE_LIMITS.chat_truncate.max, RATE_LIMITS.chat_truncate.windowMs),
      ],
    },
    async (request, reply) => {
      const params = truncateParamsSchema.safeParse(request.params);
      const body = truncateBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ message: "Invalid request." });
      }

      const { data: conversation, error } = await fastify.supabaseAdmin
        .from("conversations")
        .select("id, projects!inner(user_id)")
        .eq("id", body.data.conversationId)
        .single();

      if (
        error ||
        !conversation ||
        (conversation as unknown as { projects: { user_id: string } }).projects.user_id !== request.user.id
      ) {
        return reply.code(404).send({ message: "Conversation not found." });
      }

      // Editing invalidates any in-flight workflow for this conversation —
      // see cancelActiveWorkflow's doc comment for why this is a blanket
      // cancel rather than precise overlap detection.
      await cancelActiveWorkflow(fastify, body.data.conversationId);
      await deleteMessageAndAfter(fastify, body.data.conversationId, params.data.messageId);
      return reply.code(204).send();
    },
  );
};

export default chatRoutes;
