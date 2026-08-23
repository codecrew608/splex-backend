import type { FastifyInstance } from "fastify";
import type { AuthedUser } from "../types/index.js";
import type { CortexDecision } from "../cortex/index.js";
import { selectModelCandidates, resolveCortexVersion } from "../cortex/index.js";
import type { SSEWriter } from "../sse/writer.js";
import {
  checkMediaQuota,
  checkConcurrentMediaLimit,
  recordMediaGeneration,
  type MediaKind,
  type MediaQuota,
} from "../credits/mediaQuota.js";
import { computeMediaCreditsCharged } from "../credits/mediaCost.js";
import { resolveCreditGateEstimate } from "../credits/costBand.js";
import { checkCredits, resolveCreditRejectionMessage } from "../credits/checkCredits.js";
import { consumeCredits } from "../credits/consumeCredits.js";
import { insertMessage } from "../persistence/messages.js";
import { insertCortexDecision } from "../persistence/cortexDecisions.js";
import { recordModelOutcome, classifyFailure } from "../cortex/modelHealth.js";
import { isBalanceExceededError } from "../openrouter/client.js";
import type { ModelRegistryRow } from "../types/index.js";

export interface SyncMediaGenerationResult {
  url: string;
  storagePath: string;
  costUsd: number;
}

// Generic over the concrete result type so a capability whose generator
// returns extra metadata (ppt's slideCount) can use it in buildMarkdown
// without casting — every kind still satisfies the base contract.
export interface SyncMediaGenerationParams<R extends SyncMediaGenerationResult = SyncMediaGenerationResult> {
  fastify: FastifyInstance;
  sse: SSEWriter;
  user: AuthedUser;
  conversationId: string;
  userMessageId?: string;
  decision: CortexDecision;
  kind: MediaKind;
  prompt: string;
  // Receives the full registry row, not just the model id — token-priced
  // kinds (ppt) need the row's cost_per_million_* to compute real cost,
  // while per-call kinds (image/audio) just read .openrouter_model_id.
  generate: (fastify: FastifyInstance, userId: string, model: ModelRegistryRow, prompt: string) => Promise<R>;
  buildMarkdown: (result: R, prompt: string) => string;
  quotaExceededMessage: (quota: MediaQuota) => string;
  unavailableMessage: string;
  failedMessage: string;
}

// Shared by every *synchronous* media capability (image now, audio now —
// video is async/job-based and does not fit this shape, see its own
// handler once built). Same quota → credit-gate → candidate-select →
// generate-with-fallback → persist → charge sequence as the original
// image-only branch this was extracted from; kind-specific behavior comes
// in entirely through the `generate`/`buildMarkdown`/message params rather
// than branching inside here.
export async function handleSyncMediaGeneration<R extends SyncMediaGenerationResult>(
  params: SyncMediaGenerationParams<R>,
): Promise<void> {
  const { fastify, sse, user, conversationId, userMessageId, decision, kind, prompt } = params;

  const quota = await checkMediaQuota(fastify, user.id, user.planTier, kind);
  if (!quota.allowed) {
    sse.error({ message: params.quotaExceededMessage(quota) });
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
  const candidates = await selectModelCandidates(fastify, kind, user.planTier, cortexVersion, decision.complexity);
  if (candidates.length === 0) {
    sse.error({ message: params.unavailableMessage });
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

  let model: ModelRegistryRow = candidates[0];
  let result: R | undefined;
  // Same reasoning as chat.ts's own fallback loop: every candidate shares
  // one OpenRouter account, so if the last failure was that account's
  // balance being unable to cover the request, no other candidate would
  // have fared differently — surface that honestly instead of the generic
  // caller-supplied failedMessage.
  let lastError: unknown;
  for (let i = 0; i < candidates.length; i++) {
    model = candidates[i];
    const startedAt = Date.now();
    try {
      result = await params.generate(fastify, user.id, model, prompt);
      recordModelOutcome(fastify, model.id, "success", Date.now() - startedAt, result.costUsd);
      break;
    } catch (err) {
      lastError = err;
      recordModelOutcome(fastify, model.id, classifyFailure(err), Date.now() - startedAt);
      fastify.log.warn({ err, model: model.openrouter_model_id, kind }, "media generation failed, trying next candidate");
    }
  }

  if (!result) {
    await recordMediaGeneration(fastify, {
      userId: user.id,
      messageId: null,
      kind,
      status: "failed",
      prompt,
      errorMessage: "generation failed on every candidate",
    });
    sse.error({
      message: isBalanceExceededError(lastError)
        ? "This AI service is temporarily unavailable. Please try again shortly."
        : params.failedMessage,
    });
    sse.done({ blocked: true, conversationId, userMessageId });
    sse.end();
    return;
  }

  const markdown = params.buildMarkdown(result, prompt);
  sse.token({ delta: markdown });

  const creditsCharged = computeMediaCreditsCharged(fastify, result.costUsd);
  const assistantMessageId = await insertMessage(fastify, {
    conversationId,
    role: "assistant",
    content: markdown,
    intent: decision.intentId,
    complexity: decision.complexity,
    creditsCharged,
    routedModel: model.openrouter_model_id,
  });

  await recordMediaGeneration(fastify, {
    userId: user.id,
    messageId: assistantMessageId,
    kind,
    status: "completed",
    storagePath: result.storagePath,
    prompt,
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

  sse.done({ messageId: assistantMessageId, conversationId, creditsCharged, userMessageId });
  sse.end();
}

export interface AsyncMediaJob {
  jobId: string;
  pollingUrl: string;
}

export interface AsyncMediaGenerationParams {
  fastify: FastifyInstance;
  sse: SSEWriter;
  user: AuthedUser;
  conversationId: string;
  userMessageId?: string;
  decision: CortexDecision;
  kind: MediaKind;
  prompt: string;
  maxConcurrent: number;
  submit: (fastify: FastifyInstance, model: string, prompt: string) => Promise<AsyncMediaJob>;
  placeholderContent: string;
  quotaExceededMessage: (quota: MediaQuota) => string;
  concurrencyExceededMessage: string;
  unavailableMessage: string;
  submitFailedMessage: string;
}

// For genuinely async media (video; PPT later if it ends up job-based) —
// unlike handleSyncMediaGeneration above, this only ever submits the job
// and returns; the request must never block for the full generation (spec
// requirement, and there's no proxy/timeout budget in this stack that
// would tolerate a multi-minute open HTTP response anyway). Real billing
// happens later, at completion time, from routes/media.ts's status poll —
// nothing is charged here because nothing has actually been produced yet.
export async function handleAsyncMediaGeneration(params: AsyncMediaGenerationParams): Promise<void> {
  const { fastify, sse, user, conversationId, userMessageId, decision, kind, prompt } = params;

  const quota = await checkMediaQuota(fastify, user.id, user.planTier, kind);
  if (!quota.allowed) {
    sse.error({ message: params.quotaExceededMessage(quota) });
    sse.done({ blocked: true, conversationId, userMessageId });
    sse.end();
    return;
  }

  const withinConcurrency = await checkConcurrentMediaLimit(fastify, user.id, kind, params.maxConcurrent);
  if (!withinConcurrency) {
    sse.error({ message: params.concurrencyExceededMessage });
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
  const candidates = await selectModelCandidates(fastify, kind, user.planTier, cortexVersion, decision.complexity);
  if (candidates.length === 0) {
    sse.error({ message: params.unavailableMessage });
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

  let model: ModelRegistryRow = candidates[0];
  let job: AsyncMediaJob | undefined;
  let lastError: unknown;
  for (let i = 0; i < candidates.length; i++) {
    model = candidates[i];
    const startedAt = Date.now();
    try {
      job = await params.submit(fastify, model.openrouter_model_id, prompt);
      // Only the *submission* succeeded — the generation itself is still
      // running, and its real outcome/cost is recorded later by
      // routes/media.ts when the job reaches a terminal state.
      recordModelOutcome(fastify, model.id, "success", Date.now() - startedAt);
      break;
    } catch (err) {
      lastError = err;
      recordModelOutcome(fastify, model.id, classifyFailure(err), Date.now() - startedAt);
      fastify.log.warn({ err, model: model.openrouter_model_id, kind }, "async media submit failed, trying next candidate");
    }
  }

  if (!job) {
    // Same pattern as handleSyncMediaGeneration's own all-candidates-failed
    // branch above — live testing found this one skipped it, so a run of
    // failed video submissions (e.g. an upstream account issue) left zero
    // trace in generated_media, unlike every other capability's failure
    // path. Doesn't change quota math either way (status='failed' rows are
    // already excluded from quota counts) — this is purely closing an
    // observability gap.
    await recordMediaGeneration(fastify, {
      userId: user.id,
      messageId: null,
      kind,
      status: "failed",
      prompt,
      errorMessage: "submission failed on every candidate",
    });
    sse.error({
      message: isBalanceExceededError(lastError)
        ? "This AI service is temporarily unavailable. Please try again shortly."
        : params.submitFailedMessage,
    });
    sse.done({ blocked: true, conversationId, userMessageId });
    sse.end();
    return;
  }

  sse.token({ delta: params.placeholderContent });

  const assistantMessageId = await insertMessage(fastify, {
    conversationId,
    role: "assistant",
    content: params.placeholderContent,
    intent: decision.intentId,
    complexity: decision.complexity,
    routedModel: model.openrouter_model_id,
  });

  const mediaId = await recordMediaGeneration(fastify, {
    userId: user.id,
    messageId: assistantMessageId,
    kind,
    status: "queued",
    prompt,
    providerJobId: job.pollingUrl,
    openrouterModelId: model.openrouter_model_id,
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

  sse.done({
    messageId: assistantMessageId,
    conversationId,
    userMessageId,
    pendingMediaId: mediaId ?? undefined,
  });
  sse.end();
}
