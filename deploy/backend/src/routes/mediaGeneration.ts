import type { FastifyInstance } from "fastify";
import type { AuthedUser } from "../types/index.js";
import type { CortexDecision } from "../cortex/index.js";
import { selectModelCandidates, resolveCortexVersion } from "../cortex/index.js";
import type { SSEWriter } from "../sse/writer.js";
import {
  checkMediaQuota,
  checkConcurrentMediaLimit,
  recordMediaGeneration,
  updateGeneratedMediaStatus,
  type MediaKind,
  type MediaQuota,
} from "../credits/mediaQuota.js";
import { computeMediaCreditsCharged } from "../credits/mediaCost.js";
import { resolveCreditGateEstimate } from "../credits/costBand.js";
import {
  checkAndReserveCredits,
  settleDailyReservation,
  resolveCreditRejectionMessage,
  reserveMediaCredits,
  settleMediaReservation,
  releaseStaleMediaReservations,
} from "../credits/checkCredits.js";
import { consumeCredits } from "../credits/consumeCredits.js";
import { insertMessage, updateMessageResult } from "../persistence/messages.js";
import { insertCortexDecision } from "../persistence/cortexDecisions.js";
import { recordModelOutcome, recordModelFailure } from "../cortex/modelHealth.js";
import { isBalanceExceededError, describeError } from "../openrouter/client.js";
import type { ModelRegistryRow } from "../types/index.js";

export interface SyncMediaGenerationResult {
  url: string;
  storagePath: string;
  costUsd: number;
  // Audio only (audio/generate.ts) — undefined for every other kind, in
  // which case recordMediaGeneration persists null, same as before.
  durationSeconds?: number;
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

  // Set to the real charged amount only once generation genuinely
  // succeeds; stays 0 on every other exit, fully releasing the reservation.
  let dailyActualCost = 0;
  // Set the moment the placeholder row below is inserted — visible to the
  // catch block so a genuinely unexpected exception (not one of the
  // handled failure branches, which already finalize the row themselves)
  // still leaves a 'failed' row behind instead of one stuck at
  // 'streaming' forever with no explanation.
  let assistantMessageId: string | undefined;
  try {
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

    // FIX (durable persistence): inserted BEFORE the provider call below,
    // not after it succeeds. image/audio/ppt generation can take anywhere
    // from a couple seconds to tens of seconds — previously nothing was
    // persisted until it fully finished, so a client that navigated away
    // (or whose connection dropped) mid-generation came back to find the
    // user's message with no reply at all, even though real provider
    // money may already have been spent. Every exit path below now
    // finalizes THIS row via updateMessageResult instead of inserting a
    // fresh one.
    assistantMessageId = await insertMessage(fastify, {
      conversationId,
      role: "assistant",
      content: "",
      intent: decision.intentId,
      complexity: decision.complexity,
      status: "streaming",
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
        recordModelFailure(fastify, model.id, err, Date.now() - startedAt);
        fastify.log.warn({ ...describeError(err), model: model.openrouter_model_id, kind }, "media generation failed, trying next candidate");
      }
    }

    if (!result) {
      const failedMessage = isBalanceExceededError(lastError)
        ? "This AI service is temporarily unavailable. Please try again shortly."
        : params.failedMessage;
      // Finalizes the SAME row inserted above, rather than leaving it
      // stuck at 'streaming' — a reload must show this failure message,
      // never a blank bubble.
      await updateMessageResult(fastify, assistantMessageId, { content: failedMessage, status: "failed" });
      await recordMediaGeneration(fastify, {
        userId: user.id,
        messageId: null,
        kind,
        status: "failed",
        prompt,
        errorMessage: "generation failed on every candidate",
      });
      sse.error({ message: failedMessage });
      sse.done({ blocked: true, conversationId, userMessageId });
      sse.end();
      return;
    }

    const markdown = params.buildMarkdown(result, prompt);
    sse.token({ delta: markdown });

    const creditsCharged = computeMediaCreditsCharged(fastify, result.costUsd);
    dailyActualCost = creditsCharged;
    await updateMessageResult(fastify, assistantMessageId, {
      content: markdown,
      creditsCharged,
      routedModel: model.openrouter_model_id,
      status: "complete",
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
      durationSeconds: result.durationSeconds ?? null,
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

    // creditsCharged is computed above (dailyActualCost, consumeCredits,
    // recordMediaGeneration) and persisted, but never sent to the client —
    // SPLEX credits are an internal metering unit, not a product-facing
    // number (see DoneEventData's own doc comment in shared-types).
    sse.done({ messageId: assistantMessageId, conversationId, userMessageId });
    sse.end();
  } catch (err) {
    // Best-effort — never let a failure to finalize the row mask the real
    // error, and never throw over top of it. Every handled failure branch
    // above already finalizes its own row; this only catches whatever
    // wasn't anticipated (a thrown error from recordMediaGeneration,
    // insertCortexDecision, consumeCredits, or an SSE write to an already-
    // closed connection) — without it, that row would sit at 'streaming'
    // forever with no explanation, the exact bug this whole fix targets.
    if (assistantMessageId) {
      await updateMessageResult(fastify, assistantMessageId, {
        content: "Something went wrong while generating this. Please try again.",
        status: "failed",
      }).catch(() => {});
    }
    throw err;
  } finally {
    await settleDailyReservation(fastify, user.id, gate.dailyReserved, dailyActualCost);
  }
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

  // Opportunistic sweep of reservations pinned by jobs nobody ever polled
  // to completion. Runs here because this is the one place guaranteed to be
  // hit before a new video reservation is taken, so a user cannot be blocked
  // by their own abandoned job. Fire-and-forget — a sweep failure must never
  // affect this request.
  void releaseStaleMediaReservations(fastify);

  const gateEstimate = await resolveCreditGateEstimate(fastify, decision.complexity, user.planTier);

  // The row is created BEFORE the credit reservation and before submission,
  // which is a deliberate ordering change. The reservation has to be
  // attached to something durable the moment it exists: reserving first and
  // recording afterwards would leave an unreleasable reservation if anything
  // failed in between. It also tightens the concurrency race — two
  // simultaneous submits now both leave a queued row rather than both
  // sailing past a check that counts rows neither of them had created yet.
  const mediaId = await recordMediaGeneration(fastify, {
    userId: user.id,
    messageId: null,
    kind,
    status: "queued",
    prompt,
  });

  if (!mediaId) {
    sse.error({ message: params.submitFailedMessage });
    sse.done({ blocked: true, conversationId, userMessageId });
    sse.end();
    return;
  }

  // Atomic reserve-and-stamp. Unlike the read-only check_credits() this
  // replaces, two concurrent submits now serialize on Postgres's own row
  // lock and the second is rejected if the pool cannot cover both.
  const reserved = await reserveMediaCredits(fastify, mediaId, gateEstimate);
  if (!reserved) {
    await updateGeneratedMediaStatus(fastify, mediaId, {
      status: "failed",
      errorMessage: "insufficient credits at submission",
    });
    sse.error({ message: await resolveCreditRejectionMessage(fastify, user.id, gateEstimate) });
    sse.done({ blocked: true, conversationId, userMessageId });
    sse.end();
    return;
  }

  const cortexVersion = resolveCortexVersion(user.planTier);
  const candidates = await selectModelCandidates(fastify, kind, user.planTier, cortexVersion, decision.complexity);
  if (candidates.length === 0) {
    // Reservation is live from here on, so every exit below must release it.
    await settleMediaReservation(fastify, mediaId, 0);
    await updateGeneratedMediaStatus(fastify, mediaId, { status: "failed", errorMessage: "no live model for this capability" });
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
      recordModelFailure(fastify, model.id, err, Date.now() - startedAt);
      fastify.log.warn({ ...describeError(err), model: model.openrouter_model_id, kind }, "async media submit failed, trying next candidate");
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
    // Releases the reservation and marks the row we already created, rather
    // than inserting a SECOND failed row as the previous code did (the
    // reservation is attached to the existing one).
    await settleMediaReservation(fastify, mediaId, 0);
    await updateGeneratedMediaStatus(fastify, mediaId, {
      status: "failed",
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

  // 'streaming', not 'complete': this row's content is a placeholder
  // ("Generating your video...") — handlers/media.ts's polling endpoint is
  // what rewrites it to the real result (or a failure message) via
  // updateMessageResult, same as before this fix, now with an accurate
  // status alongside it.
  const assistantMessageId = await insertMessage(fastify, {
    conversationId,
    role: "assistant",
    content: params.placeholderContent,
    intent: decision.intentId,
    complexity: decision.complexity,
    routedModel: model.openrouter_model_id,
    status: "streaming",
  });

  // The row already exists (created before the reservation above) — attach
  // the message, polling URL and chosen model to it now that they exist.
  await updateGeneratedMediaStatus(fastify, mediaId, {
    status: "queued",
    messageId: assistantMessageId,
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
