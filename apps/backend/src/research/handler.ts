import type { FastifyInstance } from "fastify";
import type { AuthedUser } from "../types/index.js";
import type { CortexDecision } from "../cortex/index.js";
import { selectModelCandidates, resolveCortexVersion } from "../cortex/index.js";
import type { SSEWriter } from "../sse/writer.js";
import { checkMediaQuota, recordMediaGeneration } from "../credits/mediaQuota.js";
import { computeMediaCreditsCharged } from "../credits/mediaCost.js";
import { resolveCreditGateEstimate } from "../credits/costBand.js";
import { checkCredits, resolveCreditRejectionMessage } from "../credits/checkCredits.js";
import { consumeCredits } from "../credits/consumeCredits.js";
import { insertMessage } from "../persistence/messages.js";
import { insertCortexDecision } from "../persistence/cortexDecisions.js";
import { recordModelOutcome, classifyFailure } from "../cortex/modelHealth.js";
import { isBalanceExceededError } from "../openrouter/client.js";
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

  const quota = await checkMediaQuota(fastify, user.id, user.planTier, "web_search");
  if (!quota.allowed) {
    const message =
      quota.limit === 0
        ? "Web search isn't available on your plan."
        : `You've reached today's web search limit (${quota.limit}/day).`;
    sse.error({ message });
    sse.done({ blocked: true, conversationId, userMessageId });
    sse.end();
    return;
  }

  const gateEstimate = await resolveCreditGateEstimate(fastify, decision.complexity, user.planTier);
  const creditsAllowed = await checkCredits(fastify, user.id, gateEstimate);
  if (!creditsAllowed) {
    sse.error({ message: await resolveCreditRejectionMessage(fastify, user.id, gateEstimate) });
    sse.done({ blocked: true, conversationId, userMessageId });
    sse.end();
    return;
  }

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
      recordModelOutcome(fastify, model.id, classifyFailure(err), Date.now() - startedAt);
      fastify.log.warn({ err, model: model.openrouter_model_id }, "web search failed, trying next candidate");
    }
  }

  if (!result) {
    await recordMediaGeneration(fastify, {
      userId: user.id,
      messageId: null,
      kind: "web_search",
      status: "failed",
      prompt: query,
      errorMessage: "search failed on every candidate",
    });
    sse.error({
      message: isBalanceExceededError(lastError)
        ? "This AI service is temporarily unavailable. Please try again shortly."
        : "Web search failed, please try again.",
    });
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
  const assistantMessageId = await insertMessage(fastify, {
    conversationId,
    role: "assistant",
    content: result.text,
    intent: decision.intentId,
    complexity: decision.complexity,
    creditsCharged,
    routedModel: model.openrouter_model_id,
  });

  await recordMediaGeneration(fastify, {
    userId: user.id,
    messageId: assistantMessageId,
    kind: "web_search",
    status: "completed",
    prompt: query,
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
  });

  // Absent (not []) when nothing was actually grounded — see
  // WebSearchResult.searched's doc comment for why this distinction is
  // load-bearing (never implying a search happened when it didn't).
  sse.done({
    messageId: assistantMessageId,
    conversationId,
    userMessageId,
    creditsCharged,
    citations: result.searched ? result.citations : undefined,
  });
  sse.end();
}

export { runDeepResearch } from "./deepResearch.js";
