import type { FastifyInstance } from "fastify";
import type { AuthedUser } from "../types/index.js";
import type { CortexDecision } from "../cortex/index.js";
import { selectModelCandidates, resolveCortexVersion } from "../cortex/index.js";
import type { SSEWriter } from "../sse/writer.js";
import { checkMediaQuota, recordMediaGeneration, updateGeneratedMediaStatus } from "../credits/mediaQuota.js";
import { computeMediaCreditsCharged } from "../credits/mediaCost.js";
import { resolveCreditGateEstimate } from "../credits/costBand.js";
import { checkAndReserveCredits, settleDailyReservation, resolveCreditRejectionMessage } from "../credits/checkCredits.js";
import { consumeCredits } from "../credits/consumeCredits.js";
import { insertMessage, updateMessageResult } from "../persistence/messages.js";
import { insertCortexDecision } from "../persistence/cortexDecisions.js";
import { recordModelOutcome, recordModelFailure } from "../cortex/modelHealth.js";
import { isBalanceExceededError, describeError } from "../openrouter/client.js";
import { performWebSearch } from "./search.js";

export interface HandleWebSearchParams {
  fastify: FastifyInstance;
  sse: SSEWriter;
  user: AuthedUser;
  conversationId: string;
  userMessageId?: string;
  decision: CortexDecision;
  query: string;
}

// Ordinary web search / news — the single-completion-call capability (see
// research/search.ts). Structurally close to handleSyncMediaGeneration in
// mediaGeneration.ts but not built on it: this produces text + citations,
// never a stored file/URL, so it doesn't fit that helper's result shape
// without loosening a contract every other media kind relies on. Kept as
// its own small handler instead, still reusing the same cross-cutting
// pieces (quota, credit gate, model selection/health, credit ledger)
// directly.
export async function handleWebSearch(params: HandleWebSearchParams): Promise<void> {
  const { fastify, sse, user, conversationId, userMessageId, decision, query } = params;

  const quota = await checkMediaQuota(fastify, user.id, user.planTier, "web_search", user.timezone);
  if (!quota.allowed) {
    const message =
      quota.blockedBy === "monthly"
        ? "Your current plan limit has been reached. Please try again later or upgrade your plan."
        : quota.limit === 0
          ? "Web search isn't available on your plan."
          : "Your current usage limit has been reached. Please try again later.";
    sse.error({ message });
    sse.done({ blocked: true, conversationId, userMessageId });
    sse.end();
    return;
  }

  const gateEstimate = await resolveCreditGateEstimate(fastify, decision.complexity, user.planTier);
  // Atomically reserves gateEstimate against the DAILY pool as part of this
  // same call (reserve_daily_credits, migration 0022) — see
  // checkAndReserveCredits' doc comment in checkCredits.ts. Every exit path
  // below MUST settle this reservation exactly once — see the try/finally.
  const gate = await checkAndReserveCredits(fastify, user.id, gateEstimate);
  if (!gate.allowed) {
    sse.error({ message: await resolveCreditRejectionMessage(fastify, user.id, gateEstimate) });
    sse.done({ blocked: true, conversationId, userMessageId });
    sse.end();
    return;
  }

  // Set to the real charged amount only once the search genuinely
  // succeeds; stays 0 on every other exit, fully releasing the reservation.
  let dailyActualCost = 0;
  // Durable-persistence fix (same as handleSyncMediaGeneration/runChat):
  // visible to the catch block below so an unexpected exception still
  // finalizes the row instead of leaving it at 'streaming' forever.
  let assistantMessageId: string | undefined;
  // Capability-count race fix (same as handleSyncMediaGeneration, revisited
  // per this pass's explicit instruction) — set once the upfront
  // generated_media row is recorded, below.
  let mediaGenId: string | undefined;
  try {
    const cortexVersion = resolveCortexVersion(user.planTier);
    const candidates = await selectModelCandidates(fastify, "web_search", user.planTier, cortexVersion, decision.complexity);
    if (candidates.length === 0) {
      sse.error({ message: "Web search is temporarily unavailable, please try again shortly." });
      sse.done({ blocked: true, conversationId, userMessageId });
      sse.end();
      return;
    }

    sse.cortexDecision({
      intent: decision.intentId,
      complexity: decision.complexity,
      capabilities: decision.capabilities,
      categoryLabel: decision.categoryLabel,
      reason: decision.reason,
    });

    // FIX (durable persistence): inserted BEFORE the search/completion
    // call below — see runChat's identical fix in handlers/chat.ts for
    // the full reasoning. Every exit path below finalizes this row.
    assistantMessageId = await insertMessage(fastify, {
      conversationId,
      role: "assistant",
      content: "",
      intent: decision.intentId,
      complexity: decision.complexity,
      status: "streaming",
    });

    // FIX (capability-count concurrency race — revisited per this pass's
    // explicit instruction): checkMediaQuota's daily/monthly cap counts
    // generated_media rows, but this row was previously only ever
    // recorded AFTER the search finished. Two concurrent requests could
    // both pass checkMediaQuota (neither sees the other yet), both
    // search, and both exceed the advertised per-day web-search cap. Same
    // fix as image/audio/ppt/video/deep-research: record
    // status='processing' before the provider call.
    mediaGenId =
      (await recordMediaGeneration(fastify, {
        userId: user.id,
        messageId: assistantMessageId,
        kind: "web_search",
        status: "processing",
        prompt: query,
      })) ?? undefined;
    if (!mediaGenId) {
      const message = "Web search is temporarily unavailable, please try again shortly.";
      await updateMessageResult(fastify, assistantMessageId, { content: message, status: "failed" });
      sse.error({ message });
      sse.done({ blocked: true, conversationId, userMessageId });
      sse.end();
      return;
    }

    let model = candidates[0];
    let result: Awaited<ReturnType<typeof performWebSearch>> | undefined;
    // Every candidate shares the same OpenRouter account — if the LAST
    // attempt failed because that account's balance can't cover the request
    // (not because of anything wrong with the search itself), a different
    // model wouldn't have helped either, so the final message should say so
    // honestly rather than the generic "search failed" (see
    // isBalanceExceededError's own doc comment for why this is never
    // retryable-with-a-different-model).
    let lastError: unknown;
    for (let i = 0; i < candidates.length; i++) {
      model = candidates[i];
      const startedAt = Date.now();
      try {
        result = await performWebSearch(fastify, model.openrouter_model_id, query);
        recordModelOutcome(fastify, model.id, "success", Date.now() - startedAt, result.costUsd);
        break;
      } catch (err) {
        lastError = err;
        recordModelFailure(fastify, model.id, err, Date.now() - startedAt);
        fastify.log.warn({ ...describeError(err), model: model.openrouter_model_id }, "web search failed, trying next candidate");
      }
    }

    if (!result) {
      const failedMessage = isBalanceExceededError(lastError)
        ? "This AI service is temporarily unavailable. Please try again shortly."
        : "Web search failed, please try again.";
      await updateMessageResult(fastify, assistantMessageId, { content: failedMessage, status: "failed" });
      await updateGeneratedMediaStatus(fastify, mediaGenId, {
        status: "failed",
        errorMessage: "search failed on every candidate",
      });
      sse.error({ message: failedMessage });
      sse.done({ blocked: true, conversationId, userMessageId });
      sse.end();
      return;
    }

    sse.token({ delta: result.text });

    // Same internal cost telemetry as deepResearch.ts's runStage — see that
    // file's comment for why modelVariant + toolsUsed matter specifically
    // (a :free-variant model here still incurs a real, non-zero OpenRouter
    // tool charge for the web_search call itself).
    fastify.log.info(
      {
        event: "provider_tool_cost",
        planTier: user.planTier,
        stage: "web_search",
        modelVariant: model.variant,
        toolsUsed: ["openrouter:web_search"],
        costUsd: result.costUsd,
      },
      "web search tool cost",
    );

    const creditsCharged = computeMediaCreditsCharged(fastify, result.costUsd);
    dailyActualCost = creditsCharged;
    await updateMessageResult(fastify, assistantMessageId, {
      content: result.text,
      creditsCharged,
      routedModel: model.openrouter_model_id,
      status: "complete",
    });

    // Updates the row created up front (status='processing') rather than
    // inserting a fresh one — see its creation comment above.
    await updateGeneratedMediaStatus(fastify, mediaGenId, {
      status: "completed",
      costUsd: result.costUsd,
      creditsCharged,
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
      creditCost: creditsCharged,
      intent: decision.intentId,
      complexity: decision.complexity,
      openrouterModelId: model.openrouter_model_id,
      realCostEstimate: result.costUsd,
      // Daily is settled by settleDailyReservation() in the finally below —
      // charging it here too double-counts (see skipDaily's doc comment in
      // consumeCredits.ts; this shipped and produced an exact 2x daily
      // overcharge in production).
      skipDaily: true,
    });

    // Absent (not []) when nothing was actually grounded — see
    // WebSearchResult.searched's doc comment for why this distinction is
    // load-bearing (never implying a search happened when it didn't).
    // creditsCharged is computed above and persisted (insertMessage,
    // recordMediaGeneration, consumeCredits), never sent to the client —
    // SPLEX credits are an internal metering unit, not a product-facing
    // number.
    sse.done({
      messageId: assistantMessageId,
      conversationId,
      userMessageId,
      citations: result.searched ? result.citations : undefined,
    });
    sse.end();
  } catch (err) {
    // Best-effort — see handleSyncMediaGeneration's identical catch for
    // the full reasoning. Never masks or replaces the real error.
    if (assistantMessageId) {
      await updateMessageResult(fastify, assistantMessageId, {
        content: "Something went wrong while searching. Please try again.",
        status: "failed",
      }).catch(() => {});
    }
    if (mediaGenId) {
      await updateGeneratedMediaStatus(fastify, mediaGenId, { status: "failed", errorMessage: "unexpected error" }).catch(() => {});
    }
    throw err;
  } finally {
    await settleDailyReservation(fastify, user.id, gate.dailyReserved, dailyActualCost);
  }
}

export { runDeepResearch } from "./deepResearch.js";
