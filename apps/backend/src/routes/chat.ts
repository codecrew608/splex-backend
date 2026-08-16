import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { resolveConversation } from "../persistence/conversations.js";
import {
  insertMessage,
  deleteMessage,
  fetchRecentHistory,
  deleteMessageAndAfter,
  type HistoryMessage,
} from "../persistence/messages.js";
import { insertCortexDecision } from "../persistence/cortexDecisions.js";
import {
  runCortexClassification,
  selectModelCandidates,
  categoryToLabel,
  buildSystemPrompt,
  buildProjectContext,
} from "../cortex/index.js";
import { shouldExtractMemory, extractAndUpdateMemory } from "../memory/extractMemory.js";
import { checkCredits } from "../credits/checkCredits.js";
import { consumeCredits } from "../credits/consumeCredits.js";
import { resolveCreditGateEstimate } from "../credits/costBand.js";
import { computeRealCost } from "../credits/realCost.js";
import { streamCompletion, isRetryableOpenRouterError, type ChatContentPart } from "../openrouter/client.js";
import { SplexSSEWriter } from "../sse/writer.js";
import { fetchOwnedFiles, buildImageDataUri, buildAttachmentTextBlock } from "../files/attachments.js";
import { retrieveFileContext } from "../intelligence/retrieve.js";
import { shouldUseWorkflow } from "../cortex/workflow/trigger.js";
import { getActiveWorkflow, cancelActiveWorkflow, startWorkflow, resumeWorkflow } from "../cortex/workflow/orchestrator.js";

const chatBodySchema = z
  .object({
    conversationId: z.string().uuid().optional(),
    message: z.string().trim().min(1).max(8000).optional(),
    regenerateMessageId: z.string().uuid().optional(),
    fileIds: z.array(z.string().uuid()).max(10).optional(),
    projectId: z.string().uuid().optional(),
  })
  .refine((body) => Boolean(body.message) || Boolean(body.regenerateMessageId), {
    message: "Either message or regenerateMessageId is required.",
  });

const truncateParamsSchema = z.object({
  messageId: z.string().uuid(),
});

const truncateBodySchema = z.object({
  conversationId: z.string().uuid(),
});

const chatRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /chat — the full Cortex → OpenRouter → streamed response lifecycle.
  fastify.post("/chat", { preHandler: fastify.authenticate }, async (request, reply) => {
    const parsed = chatBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid request." });
    }
    const body = parsed.data;

    if (body.regenerateMessageId && !body.conversationId) {
      return reply.code(400).send({ message: "conversationId is required to regenerate." });
    }

    const user = request.user;
    const sse = new SplexSSEWriter(reply);

    const abortController = new AbortController();
    request.raw.on("close", () => {
      if (!reply.raw.writableEnded) abortController.abort();
    });

    // Declared outside the try block (not just outside the non-regenerate
    // branch) specifically so the catch-all handler below can also include
    // it — an OpenRouter failure thrown mid-request (e.g. upstream 429)
    // lands there, and that path needs the real user message id just as
    // much as every other completion variant does.
    let userMessageId: string | undefined;

    try {
      // Step 2: resolve or create the conversation (+ its parent project).
      const seedMessage = body.message ?? "New chat";
      const { conversationId, isNew } = await resolveConversation(
        fastify,
        user.id,
        body.conversationId,
        seedMessage,
        body.projectId,
      );
      if (isNew) {
        sse.conversationCreated({ conversationId });
      }

      // Workflow bookkeeping: editing/regenerating always invalidates an
      // in-flight workflow for this conversation (see
      // cortex/workflow/orchestrator.ts's cancelActiveWorkflow doc comment)
      // — only a plain reply while a workflow is genuinely
      // awaiting_clarification is treated as an answer to resume it. A
      // brand-new conversation can't have a prior workflow, so this is
      // skipped entirely when isNew.
      let resumableWorkflow: Awaited<ReturnType<typeof getActiveWorkflow>> = null;
      if (!isNew) {
        const active = await getActiveWorkflow(fastify, conversationId);
        if (active) {
          if (body.regenerateMessageId || active.status !== "awaiting_clarification") {
            await cancelActiveWorkflow(fastify, conversationId);
          } else {
            resumableWorkflow = active;
          }
        }
      }

      let classifierInputMessage: string;
      let history: HistoryMessage[];
      let hasImageAttachment = false;
      let imageFiles: Awaited<ReturnType<typeof fetchOwnedFiles>> = [];

      if (body.regenerateMessageId) {
        // Step 12: regenerate — drop the prior assistant message (its
        // cortex_decisions row cascades via FK), reuse the last user
        // message as the basis for a fresh generation. Any image that was
        // attached to that original turn is not reconstructed here (no
        // message<->file link is tracked) — a known, accepted gap for this
        // simple attach-to-message scope; the text portion (already baked
        // into the persisted message content) still comes through fine.
        await deleteMessage(fastify, body.regenerateMessageId);
        history = await fetchRecentHistory(fastify, conversationId);
        const lastUserMessage = [...history].reverse().find((m) => m.role === "user");
        if (!lastUserMessage) {
          sse.error({ message: "Nothing to regenerate." });
          sse.done({ blocked: true, conversationId });
          sse.end();
          return;
        }
        classifierInputMessage = lastUserMessage.content;
      } else {
        // Step 3: persist the user message immediately — history survives
        // even if everything after this fails. Attached files (owner-
        // verified, never trust client-supplied ids) get their extracted
        // text folded straight into the persisted content, so history stays
        // plain-text and every later reference sees it with zero
        // special-casing at the OpenRouter-usage-accounting layer.
        const attachedFiles = await fetchOwnedFiles(fastify, user.id, body.fileIds ?? []);
        imageFiles = attachedFiles.filter((f) => f.mime_type?.startsWith("image/"));
        hasImageAttachment = imageFiles.length > 0;
        const attachmentTextBlock = buildAttachmentTextBlock(attachedFiles);

        classifierInputMessage = `${attachmentTextBlock}${body.message as string}`;
        userMessageId = await insertMessage(fastify, { conversationId, role: "user", content: classifierInputMessage });
        history = await fetchRecentHistory(fastify, conversationId);
      }

      // Shared context — memory, file RAG, and (new) project context —
      // fetched once and reused across the single-shot path AND every step
      // of a workflow (start or resume), never re-fetched per step.
      const [{ data: memoryRow }, fileContext, projectContext] = await Promise.all([
        fastify.supabaseAdmin.from("user_memory").select("summary_text").eq("user_id", user.id).maybeSingle(),
        retrieveFileContext(fastify, user.id, classifierInputMessage, body.fileIds ?? []),
        buildProjectContext(fastify, conversationId),
      ]);
      const systemPromptText = buildSystemPrompt(memoryRow?.summary_text ?? null, fileContext, projectContext);
      const contextBlock = [
        memoryRow?.summary_text ? `What you remember about this user:\n${memoryRow.summary_text}` : "",
        fileContext ? `Relevant file excerpts:\n${fileContext}` : "",
        projectContext ? `Project: ${projectContext}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      // Resume path: a plain reply while a workflow is paused on a
      // clarifying question. Bypasses classification/gating entirely — the
      // orchestrator owns its own per-step credit checks.
      if (resumableWorkflow && userMessageId) {
        const result = await resumeWorkflow({
          fastify,
          sse,
          user,
          conversationId,
          answer: body.message as string,
          run: resumableWorkflow,
          contextBlock,
          systemPromptText,
          abortSignal: abortController.signal,
        });
        if (result.handled) return;
        // else: race lost or the resume itself fell back — continue below
        // as an ordinary single-shot turn using the message already persisted.
      }

      // Step 4
      sse.cortexStatus({ stage: "understanding", label: "Understanding task..." });
      const decision = await runCortexClassification(fastify, classifierInputMessage);
      if (hasImageAttachment) {
        // An attached image should deterministically route to a
        // vision-capable model — the text alone often won't signal vision
        // need (e.g. "what's wrong with this" + a screenshot), so this
        // overrides whatever the text classifier decided.
        decision.category = "vision";
        decision.categoryLabel = categoryToLabel("vision");
      }
      sse.cortexStatus({ stage: "detecting_requirements", label: "Detecting requirements..." });

      // Workflow trigger: only for a fresh, non-regenerate, non-vision
      // plain message that scores as an outcome-shaped complex request
      // (see trigger.ts — deliberately conservative). Vision stays
      // single-shot for v1, keeping image-attachment handling unchanged.
      if (
        !body.regenerateMessageId &&
        !hasImageAttachment &&
        userMessageId &&
        shouldUseWorkflow(decision.complexity, classifierInputMessage)
      ) {
        const result = await startWorkflow({
          fastify,
          sse,
          user,
          conversationId,
          userMessageId,
          message: classifierInputMessage,
          contextBlock,
          systemPromptText,
          abortSignal: abortController.signal,
        });
        if (result.handled) return;
        // else: planning decided this doesn't actually need decomposition
        // — fall through to ordinary single-shot handling below, silently.
      }

      // Step 5: pre-flight gate estimate — a percentage of THIS user's own
      // plan total, not a fixed number, so it can never exceed what any
      // tier can afford. The real charge is computed after generation from
      // actual token usage (see step 10) and can differ from this estimate.
      const gateEstimate = await resolveCreditGateEstimate(fastify, decision.complexity, user.planTier);

      // Step 6: hard gate before any generation happens.
      const allowed = await checkCredits(fastify, user.id, gateEstimate);
      if (!allowed) {
        sse.error({ message: "You're out of SPLEX credits." });
        sse.done({ blocked: true, conversationId, userMessageId });
        sse.end();
        return;
      }

      // Step 7: THE free/paid isolation mechanism. Up to 2 ranked
      // candidates — if the first hits a rate-limited/transient upstream
      // failure, step 9's stream loop retries with the second before
      // giving up (see isRetryableOpenRouterError's doc comment for why
      // this is safe to retry rather than just failing outright).
      sse.cortexStatus({ stage: "selecting_capability", label: "Selecting AI capability..." });
      const modelCandidates = await selectModelCandidates(fastify, decision.category, user.planTier, 2);
      if (modelCandidates.length === 0) {
        sse.error({ message: "This capability is temporarily unavailable, please try again shortly." });
        sse.done({ blocked: true, conversationId, userMessageId });
        sse.end();
        return;
      }

      // Step 8: stripped payload only — no model_selected/openrouter_model_id.
      sse.cortexStatus({ stage: "executing", label: "Executing..." });
      sse.cortexDecision({
        intent: decision.intentId,
        complexity: decision.complexity,
        capabilities: decision.capabilities,
        categoryLabel: decision.categoryLabel,
        reason: decision.reason,
      });

      // Step 9. History stays plain-text for every prior turn; only the
      // current turn (last item, guaranteed since it was just persisted
      // above) gets rewritten into multimodal content parts when an image
      // is attached. computeRealCost() needs no changes for this — it's
      // still just more content in the same tracked messages array, so
      // OpenRouter's usage.prompt_tokens covers it automatically.
      const completionMessages: Array<{ role: "system" | "user" | "assistant"; content: string | ChatContentPart[] }> = [
        { role: "system", content: systemPromptText },
        ...history.map((m) => ({ role: m.role, content: m.content as string })),
      ];

      if (hasImageAttachment) {
        const lastMessage = completionMessages[completionMessages.length - 1];
        const imageParts = (
          await Promise.all(imageFiles.map((f) => buildImageDataUri(fastify, f)))
        ).filter((uri): uri is string => uri !== null);

        if (imageParts.length > 0 && typeof lastMessage.content === "string") {
          lastMessage.content = [
            { type: "text", text: lastMessage.content },
            ...imageParts.map((url): ChatContentPart => ({ type: "image_url", image_url: { url } })),
          ];
        }
      }

      let model = modelCandidates[0];
      let generation: Awaited<ReturnType<typeof streamCompletion>> | undefined;
      for (let i = 0; i < modelCandidates.length; i++) {
        model = modelCandidates[i];
        try {
          generation = await streamCompletion({
            fastify,
            model: model.openrouter_model_id,
            messages: completionMessages,
            signal: abortController.signal,
            onToken: (delta) => sse.token({ delta }),
          });
          break;
        } catch (err) {
          const isLastCandidate = i === modelCandidates.length - 1;
          if (!isLastCandidate && isRetryableOpenRouterError(err)) {
            fastify.log.warn(
              { err, model: model.openrouter_model_id, category: decision.category },
              "model call failed, retrying with fallback candidate",
            );
            continue;
          }
          throw err;
        }
      }
      const { fullText, usage, aborted } = generation as Awaited<ReturnType<typeof streamCompletion>>;

      if (aborted) {
        // Client disconnected mid-stream. Persist whatever text arrived
        // (better than losing it) but never charge — nothing to stream to
        // at this point, the connection is gone.
        if (fullText.trim().length > 0) {
          await insertMessage(fastify, {
            conversationId,
            role: "assistant",
            content: fullText,
            intent: decision.intentId,
            complexity: decision.complexity,
            routedModel: model.openrouter_model_id,
          });
        }
        return;
      }

      if (fullText.trim().length === 0) {
        // Step 11: nothing generated before failure — nothing persisted, nothing charged.
        sse.error({ message: "The response was interrupted, please try again." });
        sse.done({ partial: true, conversationId, userMessageId });
        sse.end();
        return;
      }

      // Step 10: clean completion. Actual charge is computed from real token
      // usage x the category's real/shadow model cost — NOT the pre-flight
      // gate estimate above, and NOT a fixed token=credit mapping.
      const realCost = await computeRealCost(fastify, decision.category, model, usage);

      const assistantMessageId = await insertMessage(fastify, {
        conversationId,
        role: "assistant",
        content: fullText,
        intent: decision.intentId,
        complexity: decision.complexity,
        creditsCharged: realCost.creditsCharged,
        routedModel: model.openrouter_model_id,
      });

      await insertCortexDecision(fastify, {
        messageId: assistantMessageId,
        intent: decision.intentId,
        complexity: decision.complexity,
        capabilities: decision.capabilities,
        category: decision.category,
        reason: decision.reason,
        modelSelected: model.openrouter_model_id,
      });

      await consumeCredits(fastify, {
        userId: user.id,
        creditCost: realCost.creditsCharged,
        intent: decision.intentId,
        complexity: decision.complexity,
        openrouterModelId: model.openrouter_model_id,
        realCostEstimate: realCost.realCostEstimateUsd,
        realInputTokens: realCost.inputTokens,
        realOutputTokens: realCost.outputTokens,
      });

      sse.done({ messageId: assistantMessageId, conversationId, creditsCharged: realCost.creditsCharged, userMessageId });
      sse.end();

      // Fire-and-forget, after the response is already sent — must never
      // add latency to what the user sees, and a failure here (logged,
      // swallowed inside extractAndUpdateMemory) never surfaces as a chat
      // error. turnNumber approximated from history length; exact count
      // doesn't matter, it's just pacing the periodic fallback trigger.
      if (shouldExtractMemory(classifierInputMessage, history.length)) {
        void extractAndUpdateMemory(fastify, user.id, classifierInputMessage, fullText);
      }
    } catch (err) {
      fastify.log.error({ err }, "/chat request failed");
      if (!reply.raw.writableEnded) {
        sse.error({ message: "Something went wrong. Please try again." });
        sse.done({ blocked: true, userMessageId });
        sse.end();
      }
    }
  });

  // Step 13 (edit message): the frontend calls this to drop the edited
  // message and everything after it, then submits the edited content as a
  // normal new POST /chat call. Full branching/versioning is a later
  // refinement — phase 1 just truncates.
  fastify.delete(
    "/chat/messages/:messageId/truncate",
    { preHandler: fastify.authenticate },
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
      // see cortex/workflow/orchestrator.ts's cancelActiveWorkflow doc
      // comment for why this is a blanket cancel rather than precise
      // overlap detection.
      await cancelActiveWorkflow(fastify, body.data.conversationId);
      await deleteMessageAndAfter(fastify, body.data.conversationId, params.data.messageId);
      return reply.code(204).send();
    },
  );
};

export default chatRoutes;
