import type { FastifyInstance } from "fastify";
import type { AuthedUser } from "../../types/index.js";
import type { SSEWriter } from "../../sse/writer.js";
import { selectModelCandidates } from "../modelSelect.js";
import { categoryToLabel } from "../labels.js";
import { resolveCortexVersion } from "../version.js";
import type { CortexVersion } from "../version.js";
import { friendlyModelName } from "../modelDisplay.js";
import { completeOnce, streamCompletion, isRetryableOpenRouterError, isBalanceExceededError } from "../../openrouter/client.js";
import { resolveMaxTokens } from "../tokenBudget.js";
import type { ModelRegistryRow } from "../../types/index.js";
import { resolveCreditGateEstimate, resolveWorkflowStepEstimate } from "../../credits/costBand.js";
import {
  checkCredits,
  checkAndReserveCredits,
  settleDailyReservation,
  diagnoseCreditRejection,
  resolveCreditRejectionMessage,
  DAILY_REQUEST_LIMIT_MESSAGE,
} from "../../credits/checkCredits.js";
import { computeRealCost } from "../../credits/realCost.js";
import { consumeCredits } from "../../credits/consumeCredits.js";
import { insertMessage, updateMessageResult } from "../../persistence/messages.js";
import { insertCortexDecision } from "../../persistence/cortexDecisions.js";
import { planWorkflow, type PlannedStep } from "./plan.js";
import { getWorkflowLimits } from "./limits.js";
import { checkDualPeriodQuota } from "../../entitlements/index.js";

const STALE_MS = 5 * 60 * 1000;
// Workflow steps are substantial generation tasks by nature — gate/charge
// every step at the "complex" band regardless of the triggering message's
// own complexity (which was already required to be "complex" for the
// workflow to trigger in the first place — see trigger.ts).
const STEP_COMPLEXITY = "complex" as const;

interface WorkflowPlanStored {
  steps: Array<{ title: string; category: string; categoryLabel: string; detailedPrompt: string }>;
}

export interface WorkflowRunRow {
  id: string;
  conversation_id: string;
  user_message_id: string;
  status: "planning" | "awaiting_clarification" | "running" | "completed" | "failed" | "cancelled";
  plan: WorkflowPlanStored | null;
  clarification_question: string | null;
  clarification_step_index: number | null;
  current_step_index: number;
  updated_at: string;
}

export async function getActiveWorkflow(fastify: FastifyInstance, conversationId: string): Promise<WorkflowRunRow | null> {
  const { data, error } = await fastify.supabaseAdmin
    .from("workflow_runs")
    .select("*")
    .eq("conversation_id", conversationId)
    .in("status", ["planning", "awaiting_clarification", "running"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  const run = data as WorkflowRunRow;

  // Dev server restarts (tsx watch) or a killed request leave a run stuck
  // 'planning'/'running' forever otherwise — no background job/queue owns
  // this, the whole step loop lives inside one HTTP request's lifetime.
  if (
    (run.status === "planning" || run.status === "running") &&
    Date.now() - new Date(run.updated_at).getTime() > STALE_MS
  ) {
    await fastify.supabaseAdmin.from("workflow_runs").update({ status: "failed" }).eq("id", run.id);
    return null;
  }

  return run;
}

// Editing or regenerating anything invalidates in-flight workflow context
// for that conversation, regardless of exact message overlap — simpler and
// more predictable than computing precise overlap.
export async function cancelActiveWorkflow(fastify: FastifyInstance, conversationId: string): Promise<void> {
  await fastify.supabaseAdmin
    .from("workflow_runs")
    .update({ status: "cancelled" })
    .eq("conversation_id", conversationId)
    .in("status", ["planning", "awaiting_clarification", "running"]);
}

interface StepEnvelope {
  status: "complete" | "needs_clarification";
  output?: string;
  question?: string;
}

function buildPriorStepsBlock(completedOutputs: Array<{ title: string; output: string }>): string {
  if (completedOutputs.length === 0) return "";
  return `\n\nPrior steps completed so far:\n${completedOutputs
    .map((s) => `[Step: ${s.title}]\n${s.output}`)
    .join("\n\n")}`;
}

type StepOutcome =
  | { kind: "completed"; output: string; creditsCharged: number }
  | { kind: "needs_clarification"; question: string }
  | { kind: "failed"; reason: string };

interface RunCtx {
  fastify: FastifyInstance;
  sse: SSEWriter;
  user: AuthedUser;
  workflowRunId: string;
  systemPromptText: string;
  abortSignal: AbortSignal;
  // Resolved once per run from user.planTier (see startWorkflow/
  // resumeWorkflow) rather than re-derived per step — a run's plan tier
  // can't change mid-execution, so every step in the same run always gets
  // the same version.
  cortexVersion: CortexVersion;
}

async function markStep(
  fastify: FastifyInstance,
  workflowRunId: string,
  stepIndex: number,
  fields: Record<string, unknown>,
): Promise<void> {
  await fastify.supabaseAdmin
    .from("workflow_steps")
    .update(fields)
    .eq("workflow_run_id", workflowRunId)
    .eq("step_index", stepIndex);
}

// Tries each ranked model candidate in order, retrying only on a
// transient/rate-limited upstream failure (see isRetryableOpenRouterError)
// — same fallback mechanism as the single-shot chat path, applied here too
// since workflow steps hit the exact same shared-:free-pool rate limits.
async function runWithModelFallback<T>(
  fastify: FastifyInstance,
  candidates: ModelRegistryRow[],
  category: string,
  attempt: (model: ModelRegistryRow) => Promise<T>,
): Promise<{ model: ModelRegistryRow; result: T }> {
  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i];
    try {
      const result = await attempt(model);
      return { model, result };
    } catch (err) {
      const isLast = i === candidates.length - 1;
      if (!isLast && isRetryableOpenRouterError(err)) {
        fastify.log.warn(
          { err, model: model.openrouter_model_id, category },
          "workflow step model call failed, retrying with fallback candidate",
        );
        continue;
      }
      throw err;
    }
  }
  throw new Error("unreachable: candidates is guaranteed non-empty by caller");
}

// Runs one step. Non-final steps use a non-streaming JSON-envelope call
// (reliable, same proven pattern as planning/memory extraction, no
// buffering needed since these are never shown live). The final step
// streams normally via the existing token SSE events, exactly like
// today's single-shot flow — if it needs to ask something, it just asks
// as part of its normal answer; there's no further step to resume into,
// so no special clarification handling is needed there.
async function executeStep(
  ctx: RunCtx,
  step: PlannedStep,
  stepIndex: number,
  isFinal: boolean,
  priorOutputs: Array<{ title: string; output: string }>,
  // Credits this step ALREADY cost on an earlier attempt — non-zero only
  // for the step being retried after a clarification pause, which was
  // genuinely charged for the round-trip in which it asked its question.
  // Added to (never replacing) what this attempt costs, so the step row
  // reflects the step's true cumulative cost rather than just its last
  // attempt. The returned creditsCharged stays the NEW charge only —
  // runSteps' caller already counts `carriedStepCredits` via
  // priorCreditsSoFar, and double-counting there is exactly the bug this
  // parameter exists to fix.
  carriedStepCredits = 0,
  // Set ONLY when isFinal — runSteps inserts this row (status:'streaming')
  // BEFORE calling this function, right when the final step (the one
  // whose output becomes a real, user-visible `messages` row) is about to
  // run, exactly mirroring handlers/chat.ts's own upfront-insert/finalize
  // pattern. Every exit path below that can be reached while isFinal is
  // true finalizes THIS SAME row via updateMessageResult instead of
  // runSteps inserting a fresh one at the end — so a client that
  // disconnects mid-final-step (or a genuinely unexpected exception) still
  // finds a real, durable row instead of the workflow's answer vanishing
  // outright. Non-final steps never receive this (it stays undefined) —
  // their output is internal, tracked only in workflow_steps, exactly as
  // before.
  assistantMessageId?: string,
): Promise<StepOutcome> {
  const { fastify, sse, user, workflowRunId, cortexVersion } = ctx;

  await markStep(fastify, workflowRunId, stepIndex, { status: "running" });
  sse.workflowStepStatus({ stepIndex, status: "running", title: step.title });

  const modelCandidates = await selectModelCandidates(fastify, step.category, user.planTier, cortexVersion);
  if (modelCandidates.length === 0) {
    await markStep(fastify, workflowRunId, stepIndex, { status: "failed" });
    sse.workflowStepStatus({ stepIndex, status: "failed", title: step.title });
    if (assistantMessageId) {
      await updateMessageResult(fastify, assistantMessageId, {
        content: "This capability is temporarily unavailable.",
        status: "failed",
      }).catch(() => {});
    }
    return { kind: "failed", reason: "This capability is temporarily unavailable." };
  }
  let model = modelCandidates[0];

  const gateEstimate = await resolveCreditGateEstimate(fastify, STEP_COMPLEXITY, user.planTier);
  // Atomically reserves gateEstimate against the DAILY pool as part of this
  // same call (reserve_daily_credits, migration 0022) — see
  // checkAndReserveCredits' doc comment in checkCredits.ts. Every exit path
  // below MUST settle this reservation exactly once — see the try/finally.
  const gate = await checkAndReserveCredits(fastify, user.id, gateEstimate);
  if (!gate.allowed) {
    await markStep(fastify, workflowRunId, stepIndex, { status: "failed" });
    sse.workflowStepStatus({ stepIndex, status: "failed", title: step.title });
    const rejectionMessage = await resolveCreditRejectionMessage(fastify, user.id, gateEstimate);
    if (assistantMessageId) {
      await updateMessageResult(fastify, assistantMessageId, { content: rejectionMessage, status: "failed" }).catch(() => {});
    }
    return { kind: "failed", reason: rejectionMessage };
  }

  // Set to the real charged amount only once this step's generation
  // genuinely succeeds (right after either computeRealCost call below);
  // stays 0 on every other exit, fully releasing the reservation.
  let dailyActualCost = 0;
  try {

  const userContent = `${step.detailedPrompt}${buildPriorStepsBlock(priorOutputs)}`;

  if (!isFinal) {
    const envelopeInstruction = `\n\nRespond with ONLY a JSON object, no prose, no markdown fences: {"status": "complete"|"needs_clarification", "output": string, "question": string}. Use "output" when status is "complete" (this is internal — not shown to the user directly, later steps will build on it). Use "question" only when status is "needs_clarification" and you genuinely cannot proceed without more information from the user.`;

    let result;
    try {
      ({ model, result } = await runWithModelFallback(fastify, modelCandidates, step.category, (m) =>
        completeOnce({
          fastify,
          model: m.openrouter_model_id,
          messages: [
            { role: "system", content: ctx.systemPromptText },
            { role: "user", content: `${userContent}${envelopeInstruction}` },
          ],
          // Reasoning-category models "think out loud" at length before
          // answering, and content-generation steps (e.g. full HTML/CSS) are
          // themselves long — 2000 wasn't enough headroom for a reasoning
          // preamble plus a full JSON response (nvidia/nemotron-3-super-120b
          // spent its whole budget on chain-of-thought and never closed the
          // envelope), and even 4000 wasn't enough for a full multi-page
          // markup step (cohere/north-mini-code hit the cap with an empty
          // message.content, all 4000 tokens apparently spent on a channel
          // this code doesn't read) — both discovered live.
          maxTokens: 6000,
        }),
      ));
    } catch (err) {
      fastify.log.error({ err, stepIndex }, "workflow step generation failed");
      await markStep(fastify, workflowRunId, stepIndex, { status: "failed" });
      sse.workflowStepStatus({ stepIndex, status: "failed", title: step.title });
      return {
        kind: "failed",
        reason: isBalanceExceededError(err)
          ? "This AI service is temporarily unavailable. Please try again shortly."
          : "Something went wrong running this step.",
      };
    }

    const realCost = await computeRealCost(fastify, step.category, model, result.usage);
    dailyActualCost = realCost.creditsCharged;
    await consumeCredits(fastify, {
      userId: user.id,
      creditCost: realCost.creditsCharged,
      intent: `workflow_step:${step.category}`,
      complexity: STEP_COMPLEXITY,
      openrouterModelId: model.openrouter_model_id,
      realCostEstimate: realCost.realCostEstimateUsd,
      realInputTokens: realCost.inputTokens,
      realOutputTokens: realCost.outputTokens,
      // Daily is settled by settleDailyReservation() in the finally below —
      // charging it here too double-counts (see skipDaily's doc comment in
      // consumeCredits.ts; this shipped and produced an exact 2x daily
      // overcharge in production).
      skipDaily: true,
    });

    let envelope: StepEnvelope | null = null;
    try {
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) envelope = JSON.parse(jsonMatch[0]) as StepEnvelope;
    } catch {
      envelope = null;
    }

    if (envelope?.status === "needs_clarification" && envelope.question) {
      await markStep(fastify, workflowRunId, stepIndex, {
        status: "awaiting_clarification",
        routed_model: model.openrouter_model_id,
        credits_charged: carriedStepCredits + realCost.creditsCharged,
        real_input_tokens: realCost.inputTokens,
        real_output_tokens: realCost.outputTokens,
      });
      return { kind: "needs_clarification", question: envelope.question };
    }

    // Fall back to the raw response whenever the envelope didn't produce
    // something usable — either it never parsed (e.g. a reasoning model
    // ran out of room, or ignored the JSON-only instruction), or it parsed
    // fine but claimed "complete" with an empty/near-empty output
    // (discovered live: a weak free-tier coding model returned valid JSON
    // with "output": "" while claiming success on a large HTML-generation
    // step). Capped, since an ungated dump would otherwise get pushed into
    // every later step's prompt as "prior context" and balloon their
    // token cost. The tail is kept, not the head, since a model that
    // reasoned first usually puts its actual answer at the end.
    const FALLBACK_OUTPUT_CAP = 3000;
    const MIN_PLAUSIBLE_OUTPUT_LENGTH = 10;
    const output =
      envelope?.output && envelope.output.trim().length >= MIN_PLAUSIBLE_OUTPUT_LENGTH
        ? envelope.output
        : result.content.slice(-FALLBACK_OUTPUT_CAP);

    // Both the envelope AND the raw fallback came up empty — the model
    // burned its whole token budget without ever producing user-visible
    // content (observed live: a "thinking"-style model emitting only to a
    // reasoning channel, leaving message.content empty). Charging for and
    // silently chaining an empty step into the next one's context is worse
    // than an honest failure — the credits were still fairly charged for
    // the generation attempt above, but the step itself did not complete.
    if (output.trim().length < MIN_PLAUSIBLE_OUTPUT_LENGTH) {
      await markStep(fastify, workflowRunId, stepIndex, {
        status: "failed",
        routed_model: model.openrouter_model_id,
        credits_charged: carriedStepCredits + realCost.creditsCharged,
        real_input_tokens: realCost.inputTokens,
        real_output_tokens: realCost.outputTokens,
      });
      sse.workflowStepStatus({ stepIndex, status: "failed", title: step.title });
      return { kind: "failed", reason: "This step didn't produce usable output, please try again." };
    }

    await markStep(fastify, workflowRunId, stepIndex, {
      status: "completed",
      output,
      routed_model: model.openrouter_model_id,
      credits_charged: carriedStepCredits + realCost.creditsCharged,
      real_input_tokens: realCost.inputTokens,
      real_output_tokens: realCost.outputTokens,
    });
    sse.workflowStepStatus({
      stepIndex,
      status: "completed",
      title: step.title,
      modelDisplayName: friendlyModelName(model.openrouter_model_id),
    });
    return { kind: "completed", output, creditsCharged: realCost.creditsCharged };
  }

  // Final step — streams live via the normal token events. Fallback is
  // still safe here: a retryable failure is always thrown from
  // streamCompletion's initial response.ok check, before onToken has ever
  // fired, so no partial tokens have reached the client yet.
  //
  // The whole final-step body from here on is wrapped in its own
  // try/catch (below) so that ANY exception — not just the ones already
  // anticipated inline (generation call failure, aborted/empty output) —
  // still finalizes assistantMessageId as 'failed' rather than letting it
  // propagate up through runSteps/startWorkflow/resumeWorkflow unfinalized
  // (chat.ts's own outer catch only knows about ITS OWN assistantMessageId
  // variable, which is never set on the workflow path — see runChat's
  // doc comment at its insert site).
  try {
    let generation;
    try {
      ({ model, result: generation } = await runWithModelFallback(fastify, modelCandidates, step.category, (m) =>
        streamCompletion({
          fastify,
          model: m.openrouter_model_id,
          messages: [
            { role: "system", content: ctx.systemPromptText },
            { role: "user", content: userContent },
          ],
          signal: ctx.abortSignal,
          onToken: (delta) => sse.token({ delta }),
          // "complex" floor, not step's own complexity — workflow steps are
          // gated/charged at the complex band regardless (see this file's
          // own comment above), and a workflow's final deliverable is
          // exactly the kind of output that needs real room.
          maxTokens: resolveMaxTokens(step.category, "complex", m),
        }),
      ));
    } catch (err) {
      fastify.log.error({ err, stepIndex }, "workflow final step generation failed");
      await markStep(fastify, workflowRunId, stepIndex, { status: "failed" });
      sse.workflowStepStatus({ stepIndex, status: "failed", title: step.title });
      const reason = isBalanceExceededError(err)
        ? "This AI service is temporarily unavailable. Please try again shortly."
        : "Something went wrong running this step.";
      if (assistantMessageId) {
        await updateMessageResult(fastify, assistantMessageId, { content: reason, status: "failed" }).catch(() => {});
      }
      return { kind: "failed", reason };
    }
    const { fullText, usage, aborted } = generation;

    if (aborted || fullText.trim().length === 0) {
      await markStep(fastify, workflowRunId, stepIndex, { status: "failed" });
      sse.workflowStepStatus({ stepIndex, status: "failed", title: step.title });
      if (assistantMessageId) {
        // Whatever streamed before the client disconnected (or the run was
        // otherwise cut short) is real content the user is entitled to
        // see — same "preserve partial content" convention as the plain
        // single-shot chat path (handlers/chat.ts). The step's own
        // workflow_steps status stays 'failed' either way (unchanged
        // above) — this only concerns the separate, user-visible
        // `messages` row.
        const hasPartial = fullText.trim().length > 0;
        await updateMessageResult(fastify, assistantMessageId, {
          content: hasPartial ? fullText : "The response was interrupted.",
          status: hasPartial ? "complete" : "failed",
        }).catch(() => {});
      }
      return { kind: "failed", reason: "The response was interrupted." };
    }

    const realCost = await computeRealCost(fastify, step.category, model, usage);
    dailyActualCost = realCost.creditsCharged;
    await consumeCredits(fastify, {
      userId: user.id,
      creditCost: realCost.creditsCharged,
      intent: `workflow_step:${step.category}`,
      complexity: STEP_COMPLEXITY,
      openrouterModelId: model.openrouter_model_id,
      realCostEstimate: realCost.realCostEstimateUsd,
      realInputTokens: realCost.inputTokens,
      realOutputTokens: realCost.outputTokens,
        // Daily is settled by settleDailyReservation() in the finally below —
        // charging it here too double-counts (see skipDaily's doc comment in
        // consumeCredits.ts; this shipped and produced an exact 2x daily
        // overcharge in production).
        skipDaily: true,
    });
    await markStep(fastify, workflowRunId, stepIndex, {
      status: "completed",
      output: fullText,
      routed_model: model.openrouter_model_id,
      credits_charged: carriedStepCredits + realCost.creditsCharged,
      real_input_tokens: realCost.inputTokens,
      real_output_tokens: realCost.outputTokens,
    });
    if (assistantMessageId) {
      await updateMessageResult(fastify, assistantMessageId, {
        content: fullText,
        creditsCharged: carriedStepCredits + realCost.creditsCharged,
        routedModel: model.openrouter_model_id,
        status: "complete",
      });
    }
    sse.workflowStepStatus({
      stepIndex,
      status: "completed",
      title: step.title,
      modelDisplayName: friendlyModelName(model.openrouter_model_id),
    });
    return { kind: "completed", output: fullText, creditsCharged: realCost.creditsCharged };
  } catch (err) {
    // Not one of the anticipated branches above (e.g. computeRealCost,
    // consumeCredits, or markStep itself threw) — the step's generation
    // may well have genuinely succeeded, but its bookkeeping didn't, so
    // there's no trustworthy partial content to preserve here the way the
    // aborted/empty branch does. Finalize honestly as failed rather than
    // leaving the row at 'streaming' forever.
    fastify.log.error({ err, stepIndex }, "workflow final step failed after generation");
    if (assistantMessageId) {
      await updateMessageResult(fastify, assistantMessageId, {
        content: "Something went wrong while generating this. Please try again.",
        status: "failed",
      }).catch(() => {});
    }
    await markStep(fastify, workflowRunId, stepIndex, { status: "failed" }).catch(() => {});
    return { kind: "failed", reason: "Something went wrong running this step." };
  } // end of the try/catch guarding the final-step branch specifically
  } finally {
    await settleDailyReservation(fastify, user.id, gate.dailyReserved, dailyActualCost);
  }
}

// Shared sequential loop used by both a fresh start and a resume. Persists
// the final step's output as a normal assistant message (indistinguishable
// from a single-shot response in history) plus its own cortex_decisions
// row for CortexStatusPanel consistency. Earlier steps are internal —
// tracked only in workflow_steps, never inserted into `messages`.
//
// CANCELLATION (see also cancelActiveWorkflow above). There is no queue or
// cancellation-token infrastructure here — a workflow runs entirely inside
// one HTTP request — so a cancel issued by a DIFFERENT request (an edit or
// regenerate in another tab) cannot interrupt a model call already in
// flight. What it CAN do, and now does, is stop the run at the next step
// boundary and never let it overwrite the cancelled state:
//
//   1. every iteration re-reads the run's status before starting a step,
//      so no FURTHER step is dispatched (and no further credits spent)
//      once a cancel has landed; and
//   2. every terminal write below is conditional on the run still being
//      'running' — the same atomic compare-and-set the resume path uses —
//      so a cancel that lands mid-step still wins the race, rather than
//      being silently overwritten by a 'completed' write moments later.
//
// Steps that already ran are still charged: the work genuinely happened.
// What cancellation guarantees is that nothing NEW is charged, and that
// the run's final recorded state is the truth.
async function isRunCancelled(fastify: FastifyInstance, workflowRunId: string): Promise<boolean> {
  const { data } = await fastify.supabaseAdmin
    .from("workflow_runs")
    .select("status")
    .eq("id", workflowRunId)
    .maybeSingle();
  return (data as { status?: string } | null)?.status === "cancelled";
}

async function runSteps(
  ctx: RunCtx,
  conversationId: string,
  steps: PlannedStep[],
  startIndex: number,
  priorOutputsSoFar: Array<{ title: string; output: string }>,
  priorCreditsSoFar = 0,
  // Credits already charged to steps[startIndex] specifically, before it
  // paused to ask a clarifying question. Only that one step carries a
  // prior charge; every later step in this loop starts from zero.
  carriedStepCredits = 0,
): Promise<
  | { outcome: "completed"; creditsCharged: number }
  | { outcome: "clarify" }
  | { outcome: "failed"; reason: string }
  | { outcome: "cancelled" }
> {
  const { fastify, sse, workflowRunId } = ctx;
  const priorOutputs = [...priorOutputsSoFar];
  let totalCredits = priorCreditsSoFar;

  for (let i = startIndex; i < steps.length; i++) {
    const step = steps[i];
    // Stop before spending anything further on a run someone cancelled.
    if (await isRunCancelled(fastify, workflowRunId)) return { outcome: "cancelled" };
    const isFinal = i === steps.length - 1;

    // FIX (durable persistence for workflows — same "insert at the end"
    // class of bug already fixed for plain chat/media/web-search/deep-
    // research): the final step's output is the only step output that
    // becomes a real, user-visible `messages` row (see this function's own
    // doc comment above) — previously that row was only ever inserted
    // AFTER executeStep had already fully succeeded, with the complete
    // content already known. A client that disconnected while the final
    // step was still streaming (or a genuinely unexpected exception during
    // its bookkeeping) left nothing durable for that turn at all. Inserted
    // here, immediately before the final step's generation begins, and
    // finalized by executeStep itself on every exit path (success, failed
    // generation, aborted/empty, or an unanticipated exception) — see its
    // assistantMessageId parameter. Non-final steps never get one; their
    // output stays internal to workflow_steps, exactly as before.
    let finalAssistantMessageId: string | undefined;
    if (isFinal) {
      finalAssistantMessageId = await insertMessage(fastify, {
        conversationId,
        role: "assistant",
        content: "",
        intent: "workflow",
        complexity: STEP_COMPLEXITY,
        status: "streaming",
      });
    }

    const result = await executeStep(
      ctx,
      step,
      i,
      isFinal,
      priorOutputs,
      i === startIndex ? carriedStepCredits : 0,
      finalAssistantMessageId,
    );

    if (result.kind === "needs_clarification") {
      await fastify.supabaseAdmin
        .from("workflow_runs")
        .update({
          status: "awaiting_clarification",
          clarification_question: result.question,
          clarification_step_index: i,
          current_step_index: i,
        })
        .eq("id", workflowRunId)
        .eq("status", "running");
      sse.workflowClarification({ question: result.question });
      return { outcome: "clarify" };
    }

    if (result.kind === "failed") {
      await fastify.supabaseAdmin
        .from("workflow_runs")
        .update({ status: "failed", current_step_index: i })
        .eq("id", workflowRunId)
        .eq("status", "running");
      return { outcome: "failed", reason: result.reason };
    }

    totalCredits += result.creditsCharged;
    priorOutputs.push({ title: step.title, output: result.output });

    if (isFinal) {
      // finalAssistantMessageId is guaranteed set here — it was inserted
      // right above, before this same step's executeStep call, and
      // executeStep's own success path already finalized its
      // content/status. What it could NOT know is this run's cumulative
      // cost across every step (it only sees this one step's own charge)
      // — patch the displayed number up to the true total now that
      // runSteps knows it, without touching content or status again.
      const assistantMessageId = finalAssistantMessageId as string;
      await updateMessageResult(fastify, assistantMessageId, {
        content: result.output,
        creditsCharged: totalCredits,
        status: "complete",
      });
      await insertCortexDecision(fastify, {
        messageId: assistantMessageId,
        intent: "workflow",
        complexity: STEP_COMPLEXITY,
        capabilities: [step.category],
        category: step.category,
        reason: `Final step of a ${steps.length}-step workflow.`,
        modelSelected: "workflow",
      });
      await fastify.supabaseAdmin
        .from("workflow_runs")
        .update({ status: "completed", current_step_index: i })
        .eq("id", workflowRunId)
        .eq("status", "running");
    } else {
      await fastify.supabaseAdmin.from("workflow_runs").update({ current_step_index: i + 1 }).eq("id", workflowRunId);
    }
  }

  return { outcome: "completed", creditsCharged: totalCredits };
}

export interface StartWorkflowResult {
  handled: boolean; // false means: fall through to ordinary single-shot chat
}

export async function startWorkflow(params: {
  fastify: FastifyInstance;
  sse: SSEWriter;
  user: AuthedUser;
  conversationId: string;
  userMessageId: string;
  message: string;
  contextBlock: string;
  systemPromptText: string;
  abortSignal: AbortSignal;
}): Promise<StartWorkflowResult> {
  const { fastify, sse, user, conversationId, userMessageId, message, contextBlock, systemPromptText, abortSignal } =
    params;
  const cortexVersion = resolveCortexVersion(user.planTier);

  const limits = await getWorkflowLimits(fastify, user.planTier);
  // maxSteps:0 means this tier's product entitlement is "no workflows" (see
  // plan_limits, migration 0032 — Free excludes workflows/agents entirely).
  // Without this check, planWorkflow would still spend a real planner-model
  // call asking for "between 2 and 0 steps", a prompt that makes no sense
  // and produces an empty/broken plan either way. Falling through to
  // ordinary single-shot chat is the correct, zero-cost degradation — the
  // same "fallback" outcome shouldUseWorkflow's caller already handles.
  if (limits.maxSteps <= 0) {
    return { handled: false };
  }

  // Structural RUN-COUNT ceiling (spec: "WORKFLOWS/AGENTS: 3 runs/day, 30
  // runs/month" — migration 0033), distinct from maxSteps/maxCostCredits
  // above (which cap a single run's size, not how many runs a user starts).
  // Checked before planWorkflow so an exhausted quota never spends a real
  // planner call — same reasoning as the maxSteps guard. Unlike that
  // guard, this IS a genuine "you're out of quota" outcome the user should
  // see, not a silent downgrade to plain chat, so it reports handled:true
  // with a clean SSE error, matching every other premium capability's
  // quota-exceeded behavior (routes/mediaGeneration.ts, research/*.ts).
  const runQuota = await checkDualPeriodQuota(
    fastify, user.id, user.planTier, "workflow_runs", "workflow_runs_monthly",
    { kind: "workflow_runs", period: "day" },
    { kind: "workflow_runs", period: "month" },
    user.timezone,
  );
  if (!runQuota.allowed) {
    const message =
      runQuota.dailyLimit !== null && runQuota.dailyUsed >= runQuota.dailyLimit
        ? "Your current usage limit has been reached. Please try again later."
        : "Your current plan limit has been reached. Please try again later or upgrade your plan.";
    sse.error({ message });
    sse.done({ blocked: true, conversationId, userMessageId });
    sse.end();
    return { handled: true };
  }

  const plan = await planWorkflow(fastify, message, contextBlock, limits.maxSteps, user.planTier);

  if (plan.outcome === "fallback") {
    return { handled: false };
  }

  if (plan.outcome === "clarify") {
    const { data: run, error } = await fastify.supabaseAdmin
      .from("workflow_runs")
      .insert({
        conversation_id: conversationId,
        user_message_id: userMessageId,
        status: "awaiting_clarification",
        clarification_question: plan.question,
        clarification_step_index: null,
      })
      .select("id")
      .single();

    if (error || !run) {
      fastify.log.error({ error }, "failed to persist workflow_runs clarification row");
      return { handled: false };
    }

    sse.workflowClarification({ question: plan.question });
    sse.done({ conversationId, userMessageId, awaitingClarification: true });
    sse.end();
    return { handled: true };
  }

  // plan.outcome === "workflow"
  // Two distinct upfront checks, both UX courtesies only, not correctness
  // guarantees — the real gate is the per-step checkCredits call inside
  // executeStep, which re-checks the live balance immediately before each
  // step actually runs (self-correcting for two-tabs-drain-the-pool, and
  // for a plan-period rollover during a multi-day clarification pause).
  const perStepEstimate = await resolveWorkflowStepEstimate(fastify, STEP_COMPLEXITY, limits.maxCostCredits);
  const estimatedTotal = perStepEstimate * plan.steps.length;

  // 1. Plan-tier workflow-cost ceiling — a structural cap independent of
  // the user's remaining balance (protects against one runaway-expensive
  // workflow, distinct from "you're just low on credits").
  if (estimatedTotal > limits.maxCostCredits) {
    sse.error({
      message: "This request is too large for your current plan limits. Try breaking it into smaller requests, or upgrade your plan.",
    });
    sse.done({ conversationId, userMessageId, blocked: true });
    sse.end();
    return { handled: true };
  }

  // 2. Live balance check. monthlyOnly: estimatedTotal is a worst-case
  // sum-of-steps number sized against the monthly pool, not a realistic
  // single charge — each step's own checkCredits call below (executeStep)
  // already does the real, both-pools-checked gating as it actually runs.
  // See checkCredits' own doc comment for the live-caught bug this avoids.
  const affordable = await checkCredits(fastify, user.id, estimatedTotal, { monthlyOnly: true });
  if (!affordable) {
    const reason = await diagnoseCreditRejection(fastify, user.id, estimatedTotal, { monthlyOnly: true });
    sse.error({
      message:
        reason === "daily_request_limit_exhausted"
          ? DAILY_REQUEST_LIMIT_MESSAGE
          : "This request is too large for your current plan limits. Try breaking it into smaller requests, or upgrade your plan.",
    });
    sse.done({ conversationId, userMessageId, blocked: true });
    sse.end();
    return { handled: true };
  }

  const stepsWithLabels = plan.steps.map((s) => ({ ...s, categoryLabel: categoryToLabel(s.category) }));

  const { data: run, error: runError } = await fastify.supabaseAdmin
    .from("workflow_runs")
    .insert({
      conversation_id: conversationId,
      user_message_id: userMessageId,
      status: "running",
      plan: { steps: stepsWithLabels },
    })
    .select("id")
    .single();

  if (runError || !run) {
    fastify.log.error({ error: runError }, "failed to persist workflow_runs row");
    return { handled: false };
  }

  const workflowRunId = run.id as string;

  const { error: stepsError } = await fastify.supabaseAdmin.from("workflow_steps").insert(
    plan.steps.map((s, index) => ({
      workflow_run_id: workflowRunId,
      step_index: index,
      title: s.title,
      category: s.category,
      category_label: categoryToLabel(s.category),
      detailed_prompt: s.detailedPrompt,
    })),
  );

  if (stepsError) {
    fastify.log.error({ error: stepsError }, "failed to persist workflow_steps rows");
    await fastify.supabaseAdmin.from("workflow_runs").update({ status: "failed" }).eq("id", workflowRunId);
    return { handled: false };
  }

  sse.workflowPlan({ steps: stepsWithLabels.map((s) => ({ title: s.title, categoryLabel: s.categoryLabel })), cortexVersion });

  const ctx: RunCtx = { fastify, sse, user, workflowRunId, systemPromptText, abortSignal, cortexVersion };
  const result = await runSteps(ctx, conversationId, plan.steps, 0, []);
  return finishRun(sse, conversationId, userMessageId, result);
}

export async function resumeWorkflow(params: {
  fastify: FastifyInstance;
  sse: SSEWriter;
  user: AuthedUser;
  conversationId: string;
  answer: string;
  run: WorkflowRunRow;
  contextBlock: string;
  systemPromptText: string;
  abortSignal: AbortSignal;
}): Promise<StartWorkflowResult> {
  const { fastify, sse, user, conversationId, answer, run, contextBlock, systemPromptText, abortSignal } = params;
  const cortexVersion = resolveCortexVersion(user.planTier);

  // Atomic claim — a no-op if another request already resumed this run.
  const { data: claimed } = await fastify.supabaseAdmin
    .from("workflow_runs")
    .update({ status: "running" })
    .eq("id", run.id)
    .eq("status", "awaiting_clarification")
    .select("id")
    .maybeSingle();

  if (!claimed) {
    return { handled: false };
  }

  const ctx: RunCtx = { fastify, sse, user, workflowRunId: run.id, systemPromptText, abortSignal, cortexVersion };

  // Planning-stage clarification (no plan existed yet) — re-plan with the
  // answer folded in as extra context. This can naturally chain across
  // multiple user turns if the planner keeps needing more detail; each
  // round is its own request, not an unbounded in-request loop.
  if (run.clarification_step_index === null || run.plan === null) {
    const limits = await getWorkflowLimits(fastify, user.planTier);
    // Same zero-step guard as startWorkflow — a plan-tier downgrade
    // between the original request and this resume must not spend a
    // planner call it can never legally use.
    if (limits.maxSteps <= 0) {
      await fastify.supabaseAdmin.from("workflow_runs").update({ status: "cancelled" }).eq("id", run.id);
      return { handled: false };
    }
    const augmentedContext = `${contextBlock}\n\nThe user was previously asked: "${run.clarification_question ?? ""}"\nTheir answer: ${answer}`;
    const plan = await planWorkflow(fastify, "(see clarification above)", augmentedContext, limits.maxSteps, user.planTier);

    if (plan.outcome === "fallback") {
      await fastify.supabaseAdmin.from("workflow_runs").update({ status: "cancelled" }).eq("id", run.id);
      return { handled: false };
    }

    if (plan.outcome === "clarify") {
      await fastify.supabaseAdmin
        .from("workflow_runs")
        .update({ status: "awaiting_clarification", clarification_question: plan.question })
        .eq("id", run.id);
      sse.workflowClarification({ question: plan.question });
      sse.done({ conversationId, userMessageId: run.user_message_id, awaitingClarification: true });
      sse.end();
      return { handled: true };
    }

    // Same two-stage affordability check as a fresh start (startWorkflow)
    // — this re-plan branch produces a brand new step list that has never
    // been checked against either the workflow-cost ceiling or the live
    // balance.
    const perStepEstimate = await resolveWorkflowStepEstimate(fastify, STEP_COMPLEXITY, limits.maxCostCredits);
    const estimatedTotal = perStepEstimate * plan.steps.length;

    if (estimatedTotal > limits.maxCostCredits) {
      await fastify.supabaseAdmin.from("workflow_runs").update({ status: "cancelled" }).eq("id", run.id);
      sse.error({
        message: "This request is too large for your current plan limits. Try breaking it into smaller requests, or upgrade your plan.",
      });
      sse.done({ conversationId, userMessageId: run.user_message_id, blocked: true });
      sse.end();
      return { handled: true };
    }

    // monthlyOnly — same reasoning as the fresh-start path above.
    const affordable = await checkCredits(fastify, user.id, estimatedTotal, { monthlyOnly: true });
    if (!affordable) {
      await fastify.supabaseAdmin.from("workflow_runs").update({ status: "cancelled" }).eq("id", run.id);
      const reason = await diagnoseCreditRejection(fastify, user.id, estimatedTotal, { monthlyOnly: true });
      sse.error({
        message:
          reason === "daily_request_limit_exhausted"
            ? DAILY_REQUEST_LIMIT_MESSAGE
            : "This request is too large for your current plan limits. Try breaking it into smaller requests, or upgrade your plan.",
      });
      sse.done({ conversationId, userMessageId: run.user_message_id, blocked: true });
      sse.end();
      return { handled: true };
    }

    const stepsWithLabels = plan.steps.map((s) => ({ ...s, categoryLabel: categoryToLabel(s.category) }));
    await fastify.supabaseAdmin
      .from("workflow_runs")
      .update({ plan: { steps: stepsWithLabels }, clarification_question: null })
      .eq("id", run.id);
    await fastify.supabaseAdmin.from("workflow_steps").insert(
      plan.steps.map((s, index) => ({
        workflow_run_id: run.id,
        step_index: index,
        title: s.title,
        category: s.category,
        category_label: categoryToLabel(s.category),
        detailed_prompt: s.detailedPrompt,
      })),
    );

    sse.workflowPlan({ steps: stepsWithLabels.map((s) => ({ title: s.title, categoryLabel: s.categoryLabel })), cortexVersion });

    const result = await runSteps(ctx, conversationId, plan.steps, 0, []);
    return finishRun(sse, conversationId, run.user_message_id, result);
  }

  // Mid-execution clarification — fold the answer into the paused step and
  // re-run it, then continue the sequential loop from there.
  const stepIndex = run.clarification_step_index;
  const steps: PlannedStep[] = run.plan.steps.map((s) => ({
    title: s.title,
    category: s.category,
    detailedPrompt: s.detailedPrompt,
  }));

  // `lte`, not `lt` — deliberately INCLUDING the paused step itself.
  //
  // Asking a clarifying question costs a real generation: the model was
  // called, tokens were spent, and executeStep charged for them before
  // returning `needs_clarification`. Fetching only `< stepIndex` (the
  // previous behaviour) meant that charge existed in the ledger and in the
  // user's pools but was invisible to the total this resume then reports —
  // so a workflow that paused once displayed LESS than it actually cost.
  // The outputs list below still uses `< stepIndex`, since the paused step
  // by definition has no output yet to feed forward.
  const { data: priorRows } = await fastify.supabaseAdmin
    .from("workflow_steps")
    .select("step_index, title, output, credits_charged, routed_model")
    .eq("workflow_run_id", run.id)
    .lte("step_index", stepIndex)
    .order("step_index", { ascending: true });

  const allRowsThroughPaused =
    (priorRows as Array<{ step_index: number; title: string; output: string | null; credits_charged: number | null; routed_model: string | null }> | null) ??
    [];
  const priorStepRows = allRowsThroughPaused.filter((r) => r.step_index < stepIndex);
  const priorOutputs = priorStepRows
    .filter((r) => r.output !== null)
    .map((r) => ({ title: r.title, output: r.output as string }));
  // Everything already charged to this run, the paused step's own
  // question-asking round-trip included.
  const priorCreditsSoFar = allRowsThroughPaused.reduce((sum, r) => sum + (r.credits_charged ?? 0), 0);
  // Split back out so the paused step's row accumulates rather than being
  // overwritten by its retry — see executeStep's carriedStepCredits.
  const carriedStepCredits = allRowsThroughPaused.find((r) => r.step_index === stepIndex)?.credits_charged ?? 0;

  steps[stepIndex] = {
    ...steps[stepIndex],
    detailedPrompt: `${steps[stepIndex].detailedPrompt}\n\nYou previously asked: "${run.clarification_question ?? ""}"\nThe user's answer: ${answer}`,
  };

  // The frontend clears its workflow panel state at the start of every
  // send (including this resume reply) and only rebuilds it from
  // workflow_plan/workflow_step_status events — re-emit the plan here so
  // the panel reappears instead of staying blank for the rest of the run
  // (discovered live: a resumed workflow completed correctly server-side,
  // but the UI showed no step progress at all afterward, since nothing
  // had re-seeded its state). Backfill "completed" for the steps that
  // were already done before the pause — runSteps below only emits
  // status updates for stepIndex onward, never re-touching earlier ones.
  sse.workflowPlan({ steps: run.plan.steps.map((s) => ({ title: s.title, categoryLabel: s.categoryLabel })), cortexVersion });
  for (let i = 0; i < stepIndex; i++) {
    const routedModel = priorStepRows[i]?.routed_model;
    sse.workflowStepStatus({
      stepIndex: i,
      status: "completed",
      title: steps[i].title,
      modelDisplayName: routedModel ? friendlyModelName(routedModel) : undefined,
    });
  }

  const result = await runSteps(ctx, conversationId, steps, stepIndex, priorOutputs, priorCreditsSoFar, carriedStepCredits);
  return finishRun(sse, conversationId, run.user_message_id, result);
}

function finishRun(
  sse: SSEWriter,
  conversationId: string,
  userMessageId: string,
  result:
    | { outcome: "completed"; creditsCharged: number }
    | { outcome: "clarify" }
    | { outcome: "failed"; reason: string }
    | { outcome: "cancelled" },
): StartWorkflowResult {
  if (result.outcome === "clarify") {
    sse.done({ conversationId, userMessageId, awaitingClarification: true });
    sse.end();
    return { handled: true };
  }
  if (result.outcome === "cancelled") {
    // Deliberately NO sse.error: a cancel means the user edited or
    // regenerated, so a newer request is already streaming them a fresh
    // answer. Surfacing an error here would put a spurious failure toast
    // on top of a perfectly good response. `partial` tells the client this
    // stream stopped early without pretending it succeeded.
    sse.done({ conversationId, userMessageId, partial: true });
    sse.end();
    return { handled: true };
  }
  if (result.outcome === "failed") {
    sse.error({ message: result.reason });
    sse.done({ conversationId, userMessageId, partial: true });
    sse.end();
    return { handled: true };
  }
  // result.creditsCharged is real, persisted per-step (executeStep's own
  // insertMessage/consumeCredits calls) — never sent to the client.
  sse.done({ conversationId, userMessageId });
  sse.end();
  return { handled: true };
}
