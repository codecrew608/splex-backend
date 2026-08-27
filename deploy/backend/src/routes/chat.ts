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
  resolveCortexVersion,
  friendlyModelName,
  explainModelSelection,
} from "../cortex/index.js";
import { shouldExtractMemory, extractAndUpdateMemory } from "../memory/extractMemory.js";
import { checkAndReserveCredits, settleDailyReservation, resolveCreditRejectionMessage } from "../credits/checkCredits.js";
import { consumeCredits } from "../credits/consumeCredits.js";
import { resolveCreditGateEstimate } from "../credits/costBand.js";
import { computeRealCost } from "../credits/realCost.js";
import { streamCompletion, isRetryableOpenRouterError, isBalanceExceededError, isModelUnavailableError, type ChatContentPart } from "../openrouter/client.js";
import { resolveMaxTokens } from "../cortex/tokenBudget.js";
import { SplexSSEWriter } from "../sse/writer.js";
import { fetchOwnedFiles, buildImageDataUri, buildAttachmentTextBlock } from "../files/attachments.js";
import { retrieveFileContext } from "../intelligence/retrieve.js";
import { shouldUseWorkflow } from "../cortex/workflow/trigger.js";
import { getActiveWorkflow, cancelActiveWorkflow, startWorkflow, resumeWorkflow } from "../cortex/workflow/orchestrator.js";
import { recordModelOutcome, recordModelFailure } from "../cortex/modelHealth.js";
import { generateImage } from "../images/generate.js";
import { generateSpeech } from "../audio/generate.js";
import { submitVideoJob } from "../video/generate.js";
import { generatePpt } from "../ppt/generate.js";
import { handleWebSearch, runDeepResearch } from "../research/handler.js";
import { handleSyncMediaGeneration, handleAsyncMediaGeneration } from "./mediaGeneration.js";
import type { MediaQuota } from "../credits/mediaQuota.js";

const MAX_CONCURRENT_VIDEO_GENERATIONS = 1;

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

// Burst protection, independent of the daily message/entitlement caps
// (entitlements/index.ts) and video's own concurrency check — this bounds
// *rate*, those bound *sustained volume*. Every media capability (image/
// audio/video/ppt) also executes through this same route (Cortex decides
// the category server-side, after the request already arrived — there's
// no separate route per capability to limit individually), so this one
// limit is what protects all of them from scripted hammering.
const CHAT_RATE_LIMIT = { max: 20, windowMs: 60_000 };
const TRUNCATE_RATE_LIMIT = { max: 30, windowMs: 60_000 };

const chatRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /chat — the full Cortex → OpenRouter → streamed response lifecycle.
  fastify.post(
    "/chat",
    { preHandler: [fastify.authenticate, fastify.rateLimitByUser("chat", CHAT_RATE_LIMIT.max, CHAT_RATE_LIMIT.windowMs)] },
    async (request, reply) => {
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
    // Server-side ONLY — resolveCortexVersion never reads anything from
    // the request. Free -> v1, Starter/Pro -> v1.5. See cortex/version.ts.
    const cortexVersion = resolveCortexVersion(user.planTier);
    const requestStartedAt = Date.now();

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

      // Image/audio generation: distinct, non-streamed, quota-gated
      // capabilities (their own daily cap on top of the normal credit pool
      // — see migration 0012) that never enter the workflow orchestrator
      // or the token-streaming path below. hasImageAttachment (vision,
      // i.e. *understanding* an attached image) already forced category to
      // "vision" above, so there's no overlap with *generating* a new one.
      if (decision.category === "image") {
        sse.cortexStatus({ stage: "selecting_capability", label: "Generating image..." });
        await handleSyncMediaGeneration({
          fastify,
          sse,
          user,
          conversationId,
          userMessageId,
          decision,
          kind: "image",
          prompt: classifierInputMessage,
          generate: (f, uid, m, p) => generateImage(f, uid, m.openrouter_model_id, p),
          buildMarkdown: (result, prompt) => `![${prompt.slice(0, 200).replace(/[[\]]/g, "")}](${result.url})`,
          quotaExceededMessage: (quota: MediaQuota) =>
            quota.limit === 0
              ? "Image generation isn't available on your plan."
              : `You've reached today's image generation limit (${quota.limit}/day${user.planTier === "free" ? " on Free — upgrade to Starter for 5/day" : ""}).`,
          unavailableMessage: "Image generation is temporarily unavailable, please try again shortly.",
          failedMessage: "Image generation failed, please try again.",
        });
        return;
      }

      if (decision.category === "audio") {
        sse.cortexStatus({ stage: "selecting_capability", label: "Generating audio..." });
        await handleSyncMediaGeneration({
          fastify,
          sse,
          user,
          conversationId,
          userMessageId,
          decision,
          kind: "audio",
          prompt: classifierInputMessage,
          generate: (f, uid, m, p) => generateSpeech(f, uid, m.openrouter_model_id, p),
          buildMarkdown: (result) => `[🔊 Generated audio](${result.url})`,
          quotaExceededMessage: (quota: MediaQuota) =>
            quota.limit === 0
              ? "Text-to-speech is a Starter feature — upgrade to unlock 5 generations/day."
              : `You've reached today's audio generation limit (${quota.limit}/day).`,
          unavailableMessage: "Audio generation is temporarily unavailable, please try again shortly.",
          failedMessage: "Audio generation failed, please try again.",
        });
        return;
      }

      // Presentations: synchronous like image/audio (the model call plans
      // the deck; the .pptx itself is assembled locally), but token-priced
      // rather than per-call — see ppt/generate.ts.
      if (decision.category === "ppt") {
        sse.cortexStatus({ stage: "selecting_capability", label: "Building your presentation..." });
        await handleSyncMediaGeneration({
          fastify,
          sse,
          user,
          conversationId,
          userMessageId,
          decision,
          kind: "ppt",
          prompt: classifierInputMessage,
          generate: generatePpt,
          buildMarkdown: (result) => `[📊 Download presentation (${result.slideCount} slides)](${result.url})`,
          quotaExceededMessage: (quota: MediaQuota) =>
            quota.limit === 0
              ? "Presentation generation is a Starter feature — upgrade to unlock 2 per day."
              : `You've reached today's presentation limit (${quota.limit}/day).`,
          unavailableMessage: "Presentation generation is temporarily unavailable, please try again shortly.",
          failedMessage: "Presentation generation failed, please try again.",
        });
        return;
      }

      // Deep research: genuine multi-stage pipeline (planning -> searching
      // -> reading sources -> cross-checking -> writing report), streamed
      // as research_stage SSE events over this same connection — see
      // research/deepResearch.ts's doc comment for why this stays
      // synchronous rather than becoming a fourth async-job pattern.
      // Pro-only; runDeepResearch itself sends the entitlement rejection
      // for Free. Kept ahead of the workflow-trigger check below: unlike
      // web_search, this requires an explicit, deliberate "deep research"
      // style phrasing to classify at all (see intents.ts), so there's no
      // realistic case where an outcome-shaped build/create request would
      // get mis-swept into it.
      if (decision.category === "deep_research") {
        await runDeepResearch({
          fastify,
          sse,
          user,
          conversationId,
          userMessageId,
          query: classifierInputMessage,
          contextBlock,
        });
        return;
      }

      // Video is the one async capability: this only submits the job and
      // returns — see handleAsyncMediaGeneration's doc comment. Real
      // completion (and billing) happens later via GET
      // /media/:id/status, which the frontend polls using the
      // pendingMediaId on the `done` event this emits.
      if (decision.category === "video") {
        sse.cortexStatus({ stage: "selecting_capability", label: "Starting video generation..." });
        await handleAsyncMediaGeneration({
          fastify,
          sse,
          user,
          conversationId,
          userMessageId,
          decision,
          kind: "video",
          prompt: classifierInputMessage,
          maxConcurrent: MAX_CONCURRENT_VIDEO_GENERATIONS,
          submit: submitVideoJob,
          placeholderContent: "🎬 Generating your video — this can take a minute or two.",
          quotaExceededMessage: (quota: MediaQuota) =>
            quota.limit === 0
              ? "Video generation is a Starter feature — upgrade to unlock 2 generations/day."
              : `You've reached today's video generation limit (${quota.limit}/day).`,
          concurrencyExceededMessage: "You already have a video generating — wait for it to finish before starting another.",
          unavailableMessage: "Video generation is temporarily unavailable, please try again shortly.",
          submitFailedMessage: "Couldn't start video generation, please try again.",
        });
        return;
      }

      // Workflow trigger: only for a fresh, non-regenerate, non-vision
      // plain message that scores as an outcome-shaped complex request
      // (see trigger.ts — deliberately conservative). Vision stays
      // single-shot for v1, keeping image-attachment handling unchanged.
      //
      // Deliberately checked BEFORE the web_search branch below (live
      // testing caught the exact failure this ordering prevents): unlike
      // every other category branch above, web_search can be selected by
      // Cortex's LLM classifier fallback on genuinely fuzzy judgment calls
      // ("Requires current web design standards" was the real reason given
      // for classifying "build me a landing page for a coffee shop" as
      // web_search) — a request that is squarely what the workflow
      // orchestrator exists for. Giving shouldUseWorkflow's own,
      // independent, conservative regex+complexity gate a chance to catch
      // that case first means one fuzzy classifier call can no longer
      // silently swallow an outcome-shaped request before workflow
      // consideration ever happens.
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

      // Web search / news: single-completion, tool-grounded answer with
      // citations. Available to both plans (spec — unlike every other
      // capability added this session, this one is NOT Pro-gated).
      if (decision.category === "web_search") {
        sse.cortexStatus({ stage: "selecting_capability", label: "Searching the web..." });
        await handleWebSearch({ fastify, sse, user, conversationId, userMessageId, decision, query: classifierInputMessage });
        return;
      }

      // Step 5: pre-flight gate estimate — a percentage of THIS user's own
      // plan total, not a fixed number, so it can never exceed what any
      // tier can afford. The real charge is computed after generation from
      // actual token usage (see step 10) and can differ from this estimate.
      const gateEstimate = await resolveCreditGateEstimate(fastify, decision.complexity, user.planTier);

      // Step 6: hard gate before any generation happens. Atomically
      // reserves gateEstimate against the DAILY pool (reserve_daily_credits,
      // migration 0022) as part of this same call — not just a read-only
      // check — closing both the estimate-vs-real-cost gap and the
      // concurrent-request race that previously let daily usage drift past
      // the 150 cap (see checkAndReserveCredits' doc comment). Every exit
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
      // succeeds (right after computeRealCost below); stays 0 on every
      // other exit (model unavailable, abort, empty response, thrown
      // error), which fully releases the reservation via the finally.
      let dailyActualCost = 0;
      try {

      // Step 7: THE free/paid isolation mechanism. Ranked candidates (2 on
      // v1, 3 on v1.5 — see modelSelect.ts) — if the first hits a
      // rate-limited/transient upstream failure, step 9's stream loop
      // retries with the next before giving up (see
      // isRetryableOpenRouterError's doc comment for why this is safe to
      // retry rather than just failing outright).
      sse.cortexStatus({ stage: "selecting_capability", label: "Selecting AI capability..." });
      const modelCandidates = await selectModelCandidates(fastify, decision.category, user.planTier, cortexVersion, decision.complexity);
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
        const startedAt = Date.now();
        try {
          generation = await streamCompletion({
            fastify,
            model: model.openrouter_model_id,
            messages: completionMessages,
            signal: abortController.signal,
            onToken: (delta) => sse.token({ delta }),
            maxTokens: resolveMaxTokens(decision.category, decision.complexity, model),
          });
          // Feeds the rolling health window the router reads (routing.ts's
          // reliabilityFor/latencyPenaltyFor). Fire-and-forget by design —
          // see recordModelOutcome.
          recordModelOutcome(fastify, model.id, "success", Date.now() - startedAt);
          break;
        } catch (err) {
          recordModelFailure(fastify, model.id, err, Date.now() - startedAt);
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
      dailyActualCost = realCost.creditsCharged;

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

      sse.done({
        messageId: assistantMessageId,
        conversationId,
        creditsCharged: realCost.creditsCharged,
        userMessageId,
        // Computed from `model` — the candidate that actually served this
        // turn post-fallback, never modelCandidates[0] — so this is never
        // wrong on a turn where the primary candidate failed over.
        routing: {
          cortexVersion,
          categoryLabel: decision.categoryLabel,
          complexity: decision.complexity,
          modelDisplayName: friendlyModelName(model.openrouter_model_id),
          reason: explainModelSelection(decision.category, decision.complexity, cortexVersion),
          creditsCharged: realCost.creditsCharged,
          responseTimeMs: Date.now() - requestStartedAt,
        },
      });
      sse.end();

      // Fire-and-forget, after the response is already sent — must never
      // add latency to what the user sees, and a failure here (logged,
      // swallowed inside extractAndUpdateMemory) never surfaces as a chat
      // error. turnNumber approximated from history length; exact count
      // doesn't matter, it's just pacing the periodic fallback trigger.
      if (shouldExtractMemory(classifierInputMessage, history.length, (memoryRow?.summary_text ?? "").length)) {
        void extractAndUpdateMemory(fastify, user.id, classifierInputMessage, fullText);
      }
      } finally {
        // Fires on every exit from the try above — normal completion,
        // an early return (model unavailable / aborted / empty response),
        // or a thrown error re-thrown to the outer catch below.
        // dailyActualCost is still 0 on every path that didn't reach the
        // success assignment, which correctly releases the full
        // reservation rather than leaking it against the user's daily pool.
        await settleDailyReservation(fastify, user.id, gate.dailyReserved, dailyActualCost);
      }
    } catch (err) {
      // Explicit field-by-field serialization, not the raw Error in `err` —
      // an Error's message/stack/name are non-enumerable own properties, so
      // any logging path that JSON-serializes this object (Cloudflare's
      // console capture on the Worker side does exactly this — see
      // worker/context.ts's makeLogger) silently collapses it to `{}`,
      // exactly what was observed in production ("/chat request failed
      // {err: {}}"). Pino (Fastify's own logger) already serializes Error
      // objects correctly, so this is more of a consistency/defense-in-depth
      // fix here than a live bug — but it's the same code path as the
      // Worker's, and matching them means this can never silently regress if
      // the logger implementation ever changes. Never logs the request body,
      // headers, or any secret — just what the JS runtime itself put on the
      // Error object.
      fastify.log.error(
        {
          errorName: err instanceof Error ? err.name : typeof err,
          errorMessage: err instanceof Error ? err.message : String(err),
          errorStack: err instanceof Error ? err.stack?.slice(0, 1000) : undefined,
        },
        "/chat request failed",
      );
      if (!reply.raw.writableEnded) {
        // Distinguished from the generic catch-all: a 402 means the
        // account's available balance can't cover this request, which is
        // an honest, specific thing to tell the user — never exposes the
        // account/key/balance itself, and no retry-with-a-different-model
        // helps here since every model shares the same account.
        sse.error({
          message:
            isBalanceExceededError(err) || isModelUnavailableError(err)
              ? // Same reasoning as the Worker port: an exhausted fallback
                // chain whose last candidate was retired upstream is a known
                // availability cause, not an unknown failure.
                "This AI service is temporarily unavailable. Please try again shortly."
              : "Something went wrong. Please try again.",
        });
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
    { preHandler: [fastify.authenticate, fastify.rateLimitByUser("chat_truncate", TRUNCATE_RATE_LIMIT.max, TRUNCATE_RATE_LIMIT.windowMs)] },
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
