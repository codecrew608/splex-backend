import type { FastifyInstance } from "fastify";


import { z } from "zod";
import { resolveConversation } from "../persistence/conversations.js";
import {
  insertMessage,
  updateMessageResult,
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
  reasoningVerificationBlock,
  categoryBlock,
  buildProjectContext,
  resolveCortexVersion,
  friendlyModelName,
  explainModelSelection,
} from "../cortex/index.js";
import {
  shouldExtractMemory,
  extractAndUpdateMemory,
  fetchMemoryFacts,
  buildMemorySummary,
  fetchProjectMemoryFacts,
  buildProjectMemorySummary,
  type ProjectMemoryContext,
} from "../memory/extractMemory.js";
import { checkAndReserveCredits, settleDailyReservation, resolveCreditRejectionMessage } from "../credits/checkCredits.js";
import { consumeCredits } from "../credits/consumeCredits.js";
import { resolveCreditGateEstimate } from "../credits/costBand.js";
import { computeRealCost } from "../credits/realCost.js";
import { streamCompletion, isRetryableOpenRouterError, isBalanceExceededError, isModelUnavailableError, type ChatContentPart, describeError } from "../openrouter/client.js";
import { resolveMaxTokens } from "../cortex/tokenBudget.js";
import { fetchOwnedFiles, buildImageDataUri, buildAttachmentTextBlock, linkFilesToMessage } from "../files/attachments.js";
import { retrieveFileContext } from "../intelligence/retrieve.js";
import { shouldUseWorkflow } from "../cortex/workflow/trigger.js";
import { getActiveWorkflow, cancelActiveWorkflow, startWorkflow, resumeWorkflow } from "../cortex/workflow/orchestrator.js";
import { recordModelOutcome, recordModelFailure } from "../cortex/modelHealth.js";
import { generateFollowUpSuggestions } from "../cortex/followUpSuggestions.js";
import { generateImage } from "../images/generate.js";
import { generateSpeech, estimateAudioRequestMinutes, MAX_AUDIO_MINUTES_PER_REQUEST } from "../audio/generate.js";
import { checkDualPeriodQuota } from "../entitlements/index.js";
import { submitVideoJob } from "../video/generate.js";
import { generatePpt } from "../ppt/generate.js";
import { handleWebSearch, runDeepResearch } from "../research/handler.js";
import { handleSyncMediaGeneration, handleAsyncMediaGeneration } from "../routes/mediaGeneration.js";
import type { MediaQuota } from "../credits/mediaQuota.js";
import type { SSEWriter } from "../sse/writer.js";
import type { AuthedUser } from "../types/index.js";

// How a runtime keeps post-response background work alive.
//
// This is the ONE genuine behavioural difference between the two entry
// points, and getting it wrong is not theoretical: memory extraction was a
// bare `void fn()` inside a waitUntil'd Worker handler, so the isolate was
// torn down mid-LLM-call and every user_memory row in production stayed
// empty. Node keeps the process alive on its own, so a floating promise is
// fine there; Workers needs execCtx.waitUntil(). Injecting it lets the
// orchestration below stay identical on both.
export type ScheduleBackground = (work: Promise<unknown>) => void;


const MAX_CONCURRENT_VIDEO_GENERATIONS = 1;

export const chatBodySchema = z
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

export const truncateBodySchema = z.object({
  conversationId: z.string().uuid(),
});

// Direct port of the async body of routes/chat.ts's POST /chat handler —
// every step, every ordering decision (workflow-before-web_search, vision
// override, etc.) preserved exactly. Only the SSE writer's concrete type
// changed (SSEWriter interface instead of the concrete SplexSSEWriter),
// which every callee below already accepts unchanged since sse/writer.ts
// was widened to the same interface this file's WorkerSSEWriter
// implements.
export async function runChat(
  fastify: FastifyInstance,
  sse: SSEWriter,
  user: AuthedUser,
  body: z.infer<typeof chatBodySchema>,
  abortController: AbortController,
  scheduleBackground: ScheduleBackground,
): Promise<void> {
  let userMessageId: string | undefined;
  // Set the moment the placeholder assistant row is inserted below —
  // visible to the outermost catch at the bottom of this function so a
  // genuinely unexpected exception still finalizes that row as 'failed'
  // instead of leaving it stuck at 'streaming' forever. See the durable-
  // persistence fix's own comment at the insert site for the full story.
  let assistantMessageId: string | undefined;
  // Same server-side-only resolution as routes/chat.ts — both entry
  // points call the identical resolveCortexVersion function imported from
  // the same cortex/version.ts module, so Fastify and the Worker can never
  // diverge on which version a given plan tier gets.
  const cortexVersion = resolveCortexVersion(user.planTier);
  const requestStartedAt = Date.now();

  try {
    const seedMessage = body.message ?? "New chat";
    const { conversationId, isNew } = await resolveConversation(fastify, user.id, body.conversationId, seedMessage, body.projectId);
    if (isNew) {
      sse.conversationCreated({ conversationId });
    }

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
    // Injected into the CURRENT turn's completionMessages below, in
    // memory, alongside the image-parts handling — never persisted. See
    // its assignment below for why this is now separate from
    // classifierInputMessage/the persisted message content.
    let attachmentTextBlock = "";

    if (body.regenerateMessageId) {
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
      const attachedFiles = await fetchOwnedFiles(fastify, user.id, body.fileIds ?? []);
      imageFiles = attachedFiles.filter((f) => f.mime_type?.startsWith("image/"));
      hasImageAttachment = imageFiles.length > 0;
      attachmentTextBlock = buildAttachmentTextBlock(attachedFiles);

      // FIX (file/image attachment display bug): classifierInputMessage
      // (classification benefits from seeing the file's content — routes
      // document-heavy questions the same regardless of whether the text
      // happens to already be in history) still includes the attachment
      // block, but what gets PERSISTED — and therefore what every future
      // turn's history replay and the user's own chat bubble show — is
      // just what they actually typed. Previously these were the same
      // string, so a document attachment's full extracted text (up to
      // 20,000 chars) rendered verbatim inside the user's own message
      // bubble as if they'd typed it, forever, on every reload, and got
      // re-sent as "history" on every subsequent turn. Images were worse:
      // never mentioned in persisted content at all (buildAttachmentTextBlock
      // excludes them by design — they go to the model via buildImageDataUri
      // instead), so an image attachment left no trace whatsoever once the
      // live SSE session ended.
      classifierInputMessage = `${attachmentTextBlock}${body.message as string}`;
      userMessageId = await insertMessage(fastify, { conversationId, role: "user", content: body.message as string });
      // Display-only metadata (MessageBubble renders a chip per linked
      // file) — the model already gets the real content this turn via
      // attachmentTextBlock/buildImageDataUri below, independent of this.
      if (attachedFiles.length > 0) {
        await linkFilesToMessage(fastify, attachedFiles.map((f) => f.id), userMessageId);
      }
      history = await fetchRecentHistory(fastify, conversationId);
    }

    // Classification depends ONLY on classifierInputMessage (already built
    // above), never on memory/files/project — so start it here and let it
    // run alongside the context fetch instead of after it. Cost drops from
    // (context + classify) to max(context, classify).
    //
    // Deliberately not awaited yet: the awaited result is consumed below,
    // after the "understanding" status event, so the SSE event ordering the
    // UI animates against is unchanged. Errors stay owned by
    // runCortexClassification (it resolves to a general fallback rather
    // than rejecting), so this can't become an unhandled rejection.
    const classificationPromise = runCortexClassification(fastify, classifierInputMessage, user.planTier);

    const [rawMemoryFacts, { data: profileRow }, fileContext, projectContext] = await Promise.all([
      fetchMemoryFacts(fastify, user.id),
      // full_name only — never date_of_birth. DOB is personal information
      // collected at signup for account purposes; there is no default
      // task-driven reason for the assistant to know it, so unlike
      // full_name it is never fetched into model context at all. If a
      // user ever tells SPLEX their birthday in conversation, that flows
      // through the normal memory-extraction path like any other stated
      // fact — a deliberate choice, not an oversight (spec: "treat DOB
      // carefully... do not surface it unnecessarily").
      fastify.supabaseAdmin.from("users").select("full_name, memory_enabled").eq("id", user.id).maybeSingle(),
      retrieveFileContext(fastify, user.id, classifierInputMessage, body.fileIds ?? []),
      buildProjectContext(fastify, conversationId),
    ]);
    // "Disable memory" (Settings): existing facts are left alone in the
    // database — this is a pause, distinct from the separate "clear all"
    // action — but stop USING them (context injection) and stop ADDING to
    // them (extraction, gated further below via this same flag) the
    // moment it's off. Defaults to true (memory_enabled's own column
    // default) for every account that predates this toggle.
    const memoryEnabled = profileRow?.memory_enabled !== false;
    const memoryFacts = memoryEnabled ? rawMemoryFacts : [];
    const memorySummary = memoryEnabled ? await buildMemorySummary(fastify, user.id, profileRow?.full_name ?? null, memoryFacts) : "";

    // Project memory (see memory/extractMemory.ts) reuses the same
    // memoryEnabled toggle as the user profile above — one switch for
    // "use/extract remembered context at all", not two independent ones a
    // user would have to understand separately.
    const projectMemoryFacts =
      memoryEnabled && projectContext ? await fetchProjectMemoryFacts(fastify, projectContext.projectId) : [];
    const projectMemorySummary = buildProjectMemorySummary(projectMemoryFacts);

    // let, not const: reasoningVerificationBlock is appended below, once
    // decision.category is known — buildSystemPrompt itself runs here,
    // in parallel WITH classification (see classificationPromise's own
    // comment above), before that's available.
    let systemPromptText = buildSystemPrompt(memorySummary, fileContext, projectContext?.title ?? null, projectMemorySummary);
    const contextBlock = [
      memorySummary ? `What you remember about this user:\n${memorySummary}` : "",
      fileContext ? `Relevant file excerpts:\n${fileContext}` : "",
      projectContext ? `Project: ${projectContext.title}` : "",
      projectMemorySummary ? `What's been established in this project:\n${projectMemorySummary}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

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
    }

    sse.cortexStatus({ stage: "understanding", label: "Understanding task..." });
    // Already in flight since before the context fetch above — usually
    // resolved by now, so this await is typically free.
    const decision = await classificationPromise;
    if (hasImageAttachment) {
      decision.category = "vision";
      decision.categoryLabel = categoryToLabel("vision");

      // Structural ceiling (spec: "VISION INPUTS: 20/day, 300/month" —
      // migration 0033) — explicitly a PAID-only ceiling, not applied to
      // Free. Vision/image-understanding is a CORE capability Free already
      // has (per the original Free/Paid spec); it stays governed purely by
      // Free's existing credit pool + free-tier vision model availability,
      // exactly as before this change. Adding a hard count cap for Free
      // here would be a real regression, not a new protection — the spec's
      // "IMPLEMENT LIMITS" list under CAPABILITY LIMITS is explicitly
      // scoped to "Paid capability ceilings" (see that section's own
      // header), so this check simply doesn't run for Free.
      if (user.planTier !== "free") {
        const visionQuota = await checkDualPeriodQuota(
          fastify, user.id, user.planTier, "vision_inputs", "vision_inputs_monthly",
          { kind: "vision_messages", period: "day" },
          { kind: "vision_messages", period: "month" },
          user.timezone,
        );
        if (!visionQuota.allowed) {
          const message =
            visionQuota.dailyLimit !== null && visionQuota.dailyUsed >= visionQuota.dailyLimit
              ? "Your current usage limit has been reached. Please try again later."
              : "Your current plan limit has been reached. Please try again later or upgrade your plan.";
          sse.error({ message });
          sse.done({ blocked: true, conversationId, userMessageId });
          sse.end();
          return;
        }
      }
    }

    // Tells the model which category Cortex actually routed this message
    // to (see categoryBlock's own doc comment) — appended here for the
    // same reason as reasoningVerificationBlock just below: buildSystemPrompt
    // above runs before decision.category is known.
    systemPromptText += categoryBlock(decision.category);

    // Domain-specific verification (accuracy pass): appended now that
    // decision.category is known, rather than threaded into
    // buildSystemPrompt above — see reasoningVerificationBlock's own doc
    // comment for why. A no-op string for every category that isn't
    // reasoning/math/coding, and for every media/tool branch below that
    // never reaches completionMessages at all.
    systemPromptText += reasoningVerificationBlock(decision.category);

    sse.cortexStatus({ stage: "detecting_requirements", label: "Detecting requirements..." });

    if (decision.category === "image") {
      sse.cortexStatus({ stage: "selecting_capability", label: "Generating image..." });
      await handleSyncMediaGeneration({
        fastify, sse, user, conversationId, userMessageId, decision,
        kind: "image", prompt: classifierInputMessage,
        generate: (f, uid, m, p) => generateImage(f, uid, m.openrouter_model_id, p),
        buildMarkdown: (result, prompt) => `![${prompt.slice(0, 200).replace(/[[\]]/g, "")}](${result.url})`,
        quotaExceededMessage: (quota: MediaQuota) =>
          quota.blockedBy === "monthly"
            ? "Your current plan limit has been reached. Please try again later or upgrade your plan."
            : quota.limit === 0
              ? "Image generation isn't available on your plan."
              : "Your current usage limit has been reached. Please try again later.",
        unavailableMessage: "Image generation is temporarily unavailable, please try again shortly.",
        failedMessage: "Image generation failed, please try again.",
      });
      return;
    }

    if (decision.category === "audio") {
      // Request-level safety ceiling (spec: max 5 minutes/request), checked
      // BEFORE any provider call or credit reservation — an estimate from
      // input length, since there's nothing to measure yet (see
      // audio/generate.ts's estimateAudioRequestMinutes doc comment).
      if (estimateAudioRequestMinutes(classifierInputMessage) > MAX_AUDIO_MINUTES_PER_REQUEST) {
        sse.error({ message: `That's too long for one audio generation (max ~${MAX_AUDIO_MINUTES_PER_REQUEST} minutes). Try a shorter script, or split it into multiple requests.` });
        sse.done({ blocked: true, conversationId, userMessageId });
        sse.end();
        return;
      }
      sse.cortexStatus({ stage: "selecting_capability", label: "Generating audio..." });
      await handleSyncMediaGeneration({
        fastify, sse, user, conversationId, userMessageId, decision,
        kind: "audio", prompt: classifierInputMessage,
        generate: (f, uid, m, p) => generateSpeech(f, uid, m.openrouter_model_id, p),
        buildMarkdown: (result) => `[🔊 Generated audio](${result.url})`,
        quotaExceededMessage: (quota: MediaQuota) =>
          quota.blockedBy === "monthly"
            ? "Your current plan limit has been reached. Please try again later or upgrade your plan."
            : quota.limit === 0
              ? "Text-to-speech is a Starter feature — upgrade to unlock it."
              : "Your current usage limit has been reached. Please try again later.",
        unavailableMessage: "Audio generation is temporarily unavailable, please try again shortly.",
        failedMessage: "Audio generation failed, please try again.",
      });
      return;
    }

    if (decision.category === "ppt") {
      sse.cortexStatus({ stage: "selecting_capability", label: "Building your presentation..." });
      await handleSyncMediaGeneration({
        fastify, sse, user, conversationId, userMessageId, decision,
        kind: "ppt", prompt: classifierInputMessage,
        generate: generatePpt,
        buildMarkdown: (result) => `[📊 Download presentation (${result.slideCount} slides)](${result.url})`,
        quotaExceededMessage: (quota: MediaQuota) =>
          quota.blockedBy === "monthly"
            ? "Your current plan limit has been reached. Please try again later or upgrade your plan."
            : quota.limit === 0
              ? "Presentation generation is a Starter feature — upgrade to unlock it."
              : "Your current usage limit has been reached. Please try again later.",
        unavailableMessage: "Presentation generation is temporarily unavailable, please try again shortly.",
        failedMessage: "Presentation generation failed, please try again.",
      });
      return;
    }

    if (decision.category === "deep_research") {
      await runDeepResearch({
        fastify, sse, user, conversationId, userMessageId,
        query: classifierInputMessage,
        contextBlock,
        // Stop burning paid provider calls the moment the client goes away.
        abortSignal: abortController.signal,
      });
      return;
    }

    if (decision.category === "video") {
      sse.cortexStatus({ stage: "selecting_capability", label: "Starting video generation..." });
      await handleAsyncMediaGeneration({
        fastify, sse, user, conversationId, userMessageId, decision,
        kind: "video", prompt: classifierInputMessage,
        maxConcurrent: MAX_CONCURRENT_VIDEO_GENERATIONS,
        submit: submitVideoJob,
        placeholderContent: "🎬 Generating your video — this can take a minute or two.",
        quotaExceededMessage: (quota: MediaQuota) =>
          quota.blockedBy === "monthly"
            ? "Your current plan limit has been reached. Please try again later or upgrade your plan."
            : quota.limit === 0
              ? "Video generation is a Starter feature — upgrade to unlock it."
              : "Your current usage limit has been reached. Please try again later.",
        concurrencyExceededMessage: "You already have a video generating — wait for it to finish before starting another.",
        unavailableMessage: "Video generation is temporarily unavailable, please try again shortly.",
        submitFailedMessage: "Couldn't start video generation, please try again.",
      });
      return;
    }

    if (
      !body.regenerateMessageId &&
      !hasImageAttachment &&
      userMessageId &&
      shouldUseWorkflow(decision.complexity, classifierInputMessage)
    ) {
      const result = await startWorkflow({
        fastify, sse, user, conversationId, userMessageId,
        message: classifierInputMessage, contextBlock, systemPromptText,
        abortSignal: abortController.signal,
      });
      if (result.handled) return;
    }

    if (decision.category === "web_search") {
      sse.cortexStatus({ stage: "selecting_capability", label: "Searching the web..." });
      await handleWebSearch({ fastify, sse, user, conversationId, userMessageId, decision, query: classifierInputMessage });
      return;
    }

    const gateEstimate = await resolveCreditGateEstimate(fastify, decision.complexity, user.planTier);
    // Atomically reserves gateEstimate against the DAILY pool as part of
    // this same call (reserve_daily_credits, migration 0022) — see
    // checkAndReserveCredits' doc comment in checkCredits.ts. Every exit
    // path from here through the end of this turn MUST settle this
    // reservation exactly once — see the try/finally below.
    const gate = await checkAndReserveCredits(fastify, user.id, gateEstimate);
    if (!gate.allowed) {
      sse.error({ message: await resolveCreditRejectionMessage(fastify, user.id, gateEstimate) });
      sse.done({ blocked: true, conversationId, userMessageId });
      sse.end();
      return;
    }

    // Set to the real charged amount only once generation genuinely
    // succeeds (right after computeRealCost below); stays 0 on every other
    // exit, which fully releases the reservation via the finally.
    let dailyActualCost = 0;
    try {

    sse.cortexStatus({ stage: "selecting_capability", label: "Selecting AI capability..." });
    const modelCandidates = await selectModelCandidates(fastify, decision.category, user.planTier, cortexVersion, decision.complexity);
    if (modelCandidates.length === 0) {
      sse.error({ message: "This capability is temporarily unavailable, please try again shortly." });
      sse.done({ blocked: true, conversationId, userMessageId });
      sse.end();
      return;
    }

    // FIX (durable persistence — the "response disappears after
    // navigation" bug): inserted BEFORE streamCompletion below, not after
    // it resolves. Previously the assistant's row was only ever inserted
    // once, at the very end, with the full final content already known —
    // so a client that navigated away, refreshed, or simply disconnected
    // while a response was still streaming had NOTHING persisted for that
    // turn: not a partially-saved reply, no row at all. Returning to the
    // conversation showed the user's message with silence after it. Every
    // exit path below (success, aborted mid-stream, aborted with nothing
    // yet, empty model output, and the outer catch at the bottom of this
    // function) now finalizes THIS SAME row via updateMessageResult
    // instead of inserting a fresh one — so a durable row, and a durable
    // id, exist from the moment generation begins, exactly as required by
    // "the database is the source of truth, React state is presentation
    // only."
    assistantMessageId = await insertMessage(fastify, {
      conversationId,
      role: "assistant",
      content: "",
      intent: decision.intentId,
      complexity: decision.complexity,
      status: "streaming",
    });

    sse.cortexStatus({ stage: "executing", label: "Executing..." });
    sse.cortexDecision({
      intent: decision.intentId, complexity: decision.complexity, capabilities: decision.capabilities,
      categoryLabel: decision.categoryLabel, reason: decision.reason,
    });

    const completionMessages: Array<{ role: "system" | "user" | "assistant"; content: string | ChatContentPart[] }> = [
      { role: "system", content: systemPromptText },
      ...history.map((m) => ({ role: m.role, content: m.content as string })),
    ];

    // Document attachments' extracted text is added to THIS turn's
    // request only, here, in memory — never persisted (see the
    // insertMessage call above, which stores just what the user typed)
    // and never replayed into a future turn's history the way it used to
    // be. history's last entry is always the just-inserted user message
    // for this (non-regenerate) branch, which is the only branch that
    // ever sets attachmentTextBlock.
    if (attachmentTextBlock && completionMessages.length > 0) {
      const lastMessage = completionMessages[completionMessages.length - 1];
      if (typeof lastMessage.content === "string") {
        lastMessage.content = `${attachmentTextBlock}${lastMessage.content}`;
      }
    }

    if (hasImageAttachment) {
      const lastMessage = completionMessages[completionMessages.length - 1];
      const imageParts = (await Promise.all(imageFiles.map((f) => buildImageDataUri(fastify, f)))).filter(
        (uri): uri is string => uri !== null,
      );
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
      const startedAt = Date.now();
      try {
        generation = await streamCompletion({
          fastify, model: model.openrouter_model_id, messages: completionMessages,
          signal: abortController.signal, onToken: (delta) => sse.token({ delta }),
          maxTokens: resolveMaxTokens(decision.category, decision.complexity, model),
        });
        recordModelOutcome(fastify, model.id, "success", Date.now() - startedAt);
        break;
      } catch (err) {
        recordModelFailure(fastify, model.id, err, Date.now() - startedAt);
        const isLastCandidate = i === modelCandidates.length - 1;
        if (!isLastCandidate && isRetryableOpenRouterError(err)) {
          fastify.log.warn(
            { ...describeError(err), model: model.openrouter_model_id, category: decision.category },
            "model call failed, retrying with fallback candidate",
          );
          continue;
        }
        throw err;
      }
    }
    const { fullText, usage, aborted } = generation as Awaited<ReturnType<typeof streamCompletion>>;

    if (aborted) {
      // Whatever streamed before the client disconnected is real content
      // the user is entitled to see on return — finalize the row with it
      // rather than leaving 'streaming' forever. Genuinely nothing
      // streamed (e.g. disconnected before the first token) gets an
      // honest "cut short" message instead of a permanently blank bubble.
      await updateMessageResult(fastify, assistantMessageId, {
        content: fullText.trim().length > 0 ? fullText : "Generation was interrupted before any response was produced.",
        routedModel: model.openrouter_model_id,
        status: fullText.trim().length > 0 ? "complete" : "failed",
      });
      return;
    }

    if (fullText.trim().length === 0) {
      const message = "The response was interrupted, please try again.";
      await updateMessageResult(fastify, assistantMessageId, { content: message, status: "failed" });
      sse.error({ message });
      sse.done({ partial: true, conversationId, userMessageId });
      sse.end();
      return;
    }

    const realCost = await computeRealCost(fastify, decision.category, model, usage);
    dailyActualCost = realCost.creditsCharged;

    await updateMessageResult(fastify, assistantMessageId, {
      content: fullText,
      creditsCharged: realCost.creditsCharged, routedModel: model.openrouter_model_id,
      status: "complete",
    });

    await insertCortexDecision(fastify, {
      messageId: assistantMessageId, intent: decision.intentId, complexity: decision.complexity,
      capabilities: decision.capabilities, category: decision.category, reason: decision.reason,
      modelSelected: model.openrouter_model_id,
    });

    await consumeCredits(fastify, {
      userId: user.id, creditCost: realCost.creditsCharged, intent: decision.intentId, complexity: decision.complexity,
      openrouterModelId: model.openrouter_model_id, realCostEstimate: realCost.realCostEstimateUsd,
      realInputTokens: realCost.inputTokens, realOutputTokens: realCost.outputTokens,
      // Daily is settled by settleDailyReservation() in the finally below —
      // charging it here too double-counts (see skipDaily's doc comment in
      // consumeCredits.ts; this shipped and produced an exact 2x daily
      // overcharge in production).
      skipDaily: true,
    });

    // Awaited (not scheduleBackground'd like memory extraction below) —
    // this needs to reach THIS response's done event to render now, not
    // next turn. Kept cheap and fast: free-tier-eligible models only, a
    // short max_tokens ceiling, and it never throws (see its own
    // try/catch) — a failure here silently means no suggestions, never a
    // broken or delayed response.
    const suggestions = await generateFollowUpSuggestions(fastify, user.planTier, classifierInputMessage, fullText);

    // realCost.creditsCharged is real, persisted (consumeCredits above) —
    // never sent to the client, on either field. SPLEX credits are an
    // internal metering unit, not a product-facing number.
    sse.done({
      messageId: assistantMessageId,
      conversationId,
      userMessageId,
      routing: {
        cortexVersion,
        categoryLabel: decision.categoryLabel,
        complexity: decision.complexity,
        modelDisplayName: friendlyModelName(model.openrouter_model_id),
        reason: explainModelSelection(decision.category, decision.complexity, cortexVersion),
        responseTimeMs: Date.now() - requestStartedAt,
      },
      suggestions: suggestions.length > 0 ? suggestions : undefined,
    });
    sse.end();

    if (memoryEnabled && shouldExtractMemory(classifierInputMessage, history.length, memoryFacts.length)) {
      // waitUntil, NOT a bare floating promise. This is why cross-chat
      // memory silently never worked in production: runChat is itself
      // wrapped in waitUntil, but `void fn()` let runChat resolve
      // immediately, which satisfied that waitUntil and allowed the
      // Workers runtime to tear the isolate down — killing an extraction
      // that makes an LLM call and takes seconds. Every user_memory row in
      // production had summary_text = '' as a result. Registering it
      // separately keeps the isolate alive until the write lands.
      //
      // Still fire-and-forget from the USER's perspective: the response
      // has already been streamed and ended above, so this adds no latency
      // to what they see, and extractAndUpdateMemory swallows its own
      // errors.
      const projectMemoryContext: ProjectMemoryContext | undefined = projectContext
        ? { projectId: projectContext.projectId, title: projectContext.title, existingFacts: projectMemoryFacts }
        : undefined;
      scheduleBackground(extractAndUpdateMemory(fastify, user.id, user.planTier, classifierInputMessage, fullText, projectMemoryContext));
    }
    } finally {
      // Fires on every exit from the try above — see routes/chat.ts's
      // identical pattern for the full reasoning.
      await settleDailyReservation(fastify, user.id, gate.dailyReserved, dailyActualCost);
    }
  } catch (err) {
    // THE actual fix for the swallowed-error bug: fastify.log here goes through
    // worker/context.ts's makeLogger(), which is a thin console.error(msg,
    // obj) wrapper — Cloudflare's console capture JSON-serializes `obj` for
    // the dashboard/wrangler tail, and JSON.stringify(someError) is `{}`
    // (Error's message/stack/name are non-enumerable own properties, so a
    // plain serializer sees nothing). That's exactly what "/chat request
    // failed {err: {}}" in production was — the object never carried
    // anything else. Pulling name/message/stack out into plain, enumerable
    // string fields survives that serialization. Never logs the request
    // body, headers, or any secret — just what the JS runtime put on the
    // Error object.
    fastify.log.error(
      describeError(err),
      "/chat request failed",
    );
    sse.error({
      message:
        isBalanceExceededError(err) || isModelUnavailableError(err)
          ? // Model-unavailable reaching here means the fallback chain was
            // exhausted and even the LAST candidate was retired upstream —
            // an availability problem on our side, not a mystery. Say so
            // honestly rather than hiding a known cause behind the generic
            // message. (recordModelFailure has already deactivated the row,
            // so the next request won't repeat this.)
            "This AI service is temporarily unavailable. Please try again shortly."
          : "Something went wrong. Please try again.",
    });
    sse.done({ blocked: true, userMessageId });
    sse.end();
    // Best-effort finalize of the durable placeholder — never let this
    // failure mask the real error above. Only reachable when an
    // assistant row genuinely exists (inserted right before
    // streamCompletion; every image/audio/ppt/video/web_search/
    // deep_research branch that returns before that point never sets
    // this, and none of them route errors through this catch either —
    // each owns its own failure finalization). Without this, an
    // exception thrown between the placeholder insert and the normal
    // finalize calls above (a thrown error from insertCortexDecision,
    // consumeCredits, or an SSE write to an already-closed connection)
    // would leave the row at 'streaming' forever — the exact bug this
    // whole fix targets.
    if (assistantMessageId) {
      await updateMessageResult(fastify, assistantMessageId, {
        content: "Something went wrong while generating this. Please try again.",
        status: "failed",
      }).catch(() => {});
    }
  }
}
