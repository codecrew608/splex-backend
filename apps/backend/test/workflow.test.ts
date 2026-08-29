import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeState, makeFastify, makeWorkflowRun, makeWorkflowStep } from "./helpers/fakeFastify.js";
import { makeFakeSSE } from "./helpers/fakeSSE.js";
import { getActiveWorkflow, cancelActiveWorkflow, startWorkflow, resumeWorkflow, type WorkflowRunRow } from "../src/cortex/workflow/orchestrator.js";
import type { AuthedUser, ModelRegistryRow } from "../src/types/index.js";

// Five Agent-Workflow scenarios that were implemented (carefully — see the
// race-safety/credit-safety comments in orchestrator.ts itself) but had
// ZERO automated coverage before this file. All state-based assertions on
// the fake's mutable counters/tables, matching fakeFastify.ts's own stated
// philosophy: a call-count spy on consumeCredits wouldn't have caught the
// production 2x-daily-overcharge bug; only checking the counter would.
//
// planWorkflow/selectModelCandidates/completeOnce/streamCompletion are the
// one real network/LLM boundary orchestrator.ts hard-imports with no DI
// seam — mocked via vi.mock() (first use of module mocking in this repo,
// deliberately scoped to just this boundary). Everything that actually
// moves a credit counter (checkCredits, checkAndReserveCredits,
// settleDailyReservation, consumeCredits, computeRealCost, ...) stays
// REAL, running against the fake supabaseAdmin below — that's what makes
// "zero credit RPC ever called" (scenario 3) an actual proof rather than a
// check on a mock's own call count.
vi.mock("../src/openrouter/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/openrouter/client.js")>();
  return { ...actual, completeOnce: vi.fn(), streamCompletion: vi.fn() };
});
vi.mock("../src/cortex/modelSelect.js", () => ({ selectModelCandidates: vi.fn() }));
vi.mock("../src/cortex/workflow/plan.js", () => ({ planWorkflow: vi.fn() }));

import { completeOnce, streamCompletion } from "../src/openrouter/client.js";
import { selectModelCandidates } from "../src/cortex/modelSelect.js";
import { planWorkflow } from "../src/cortex/workflow/plan.js";

const USER: AuthedUser = { id: "u1", email: "u1@example.com", planTier: "pro", orgId: null };

// variant:"paid" with explicit costs sidesteps needing to model
// model_registry's shadow-pricing lookup at all — computeRealCost reads
// these fields directly for a paid-variant served model (realCost.ts).
const PAID_MODEL: ModelRegistryRow = {
  id: "model-1",
  category: "writing",
  openrouter_model_id: "test/model-1",
  variant: "paid",
  capability_score: 80,
  context_length: 32000,
  cost_per_million_input: 3,
  cost_per_million_output: 15,
  is_active: true,
  priority: 1,
};

// Worked example, hand-verified: 1000 input + 2000 output tokens @ $3/$15
// per million = $0.033 -> at this repo's CREDITS_PER_USD:20000 fixture
// default -> ceil(0.033 * 20000) = 660 credits. Every mocked generation in
// this file uses this exact usage shape, so every real charge is 660 and
// every multi-step total is a clean multiple of it.
const USAGE = { prompt_tokens: 1000, completion_tokens: 2000, total_tokens: 3000 };
const STEP_COST = 660;

function completeEnvelope(output: string) {
  return { content: JSON.stringify({ status: "complete", output }), usage: USAGE, generationId: "gen-1", citations: [] };
}
function clarifyEnvelope(question: string) {
  return { content: JSON.stringify({ status: "needs_clarification", question }), usage: USAGE, generationId: "gen-1", citations: [] };
}
function streamResult(fullText: string) {
  return { fullText, usage: USAGE, aborted: false };
}

function abortSignal() {
  return new AbortController().signal;
}

beforeEach(() => {
  vi.mocked(completeOnce).mockReset();
  vi.mocked(streamCompletion).mockReset();
  vi.mocked(selectModelCandidates).mockReset();
  vi.mocked(planWorkflow).mockReset();
  vi.mocked(selectModelCandidates).mockResolvedValue([PAID_MODEL]);
});

describe("scenario 1: clarification pause -> resume", () => {
  it("1a: a planning-stage clarification pauses before any charge is even attempted", async () => {
    const state = makeState({ planTier: "pro", dailyLimit: 750, monthlyLimit: 15000, planLimits: { workflow_steps: 10, workflow_cost: 40000 } });
    const fastify = makeFastify(state);
    const sse = makeFakeSSE();
    vi.mocked(planWorkflow).mockResolvedValueOnce({ outcome: "clarify", question: "Which color scheme?" });

    const result = await startWorkflow({
      fastify, sse, user: USER, conversationId: "conv-1", userMessageId: "msg-1",
      message: "build me a site", contextBlock: "", systemPromptText: "sys", abortSignal: abortSignal(),
    });

    expect(result.handled).toBe(true);
    const runs = [...state.workflowRuns.values()];
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("awaiting_clarification");
    expect(runs[0].clarification_question).toBe("Which color scheme?");
    expect(runs[0].clarification_step_index).toBeNull();
    expect(runs[0].plan).toBeNull();
    expect(state.workflowSteps.size).toBe(0);
    // The strongest form of "no charge attempted": not even the harmless
    // upfront affordability check ran, since planning never got that far.
    expect(state.rpcCalls).toHaveLength(0);
    expect(state.dailyUsed).toBe(0);
    expect(state.monthlyUsed).toBe(0);
    expect(sse.events.filter((e) => e.type === "workflow_clarification")).toHaveLength(1);
    expect(sse.events.some((e) => e.type === "done")).toBe(true);
  });

  it("1b: resuming a planning-stage pause runs the re-planned step(s) to completion, charged once", async () => {
    const state = makeState({ planTier: "pro", dailyLimit: 750, monthlyLimit: 15000, planLimits: { workflow_steps: 10, workflow_cost: 40000 } });
    const fastify = makeFastify(state);
    const sse = makeFakeSSE();
    const runId = makeWorkflowRun(state, {
      status: "awaiting_clarification",
      clarification_question: "Which color scheme?",
      clarification_step_index: null,
      plan: null,
    });
    vi.mocked(planWorkflow).mockResolvedValueOnce({
      outcome: "workflow",
      steps: [{ title: "Write copy", category: "writing", detailedPrompt: "Write homepage copy" }],
    });
    vi.mocked(streamCompletion).mockResolvedValueOnce(streamResult("Here is your homepage copy."));

    const run = state.workflowRuns.get(runId) as unknown as WorkflowRunRow;
    const result = await resumeWorkflow({
      fastify, sse, user: USER, conversationId: "conv-1", answer: "blue and white",
      run, contextBlock: "", systemPromptText: "sys", abortSignal: abortSignal(),
    });

    expect(result.handled).toBe(true);
    expect(state.workflowRuns.get(runId)!.status).toBe("completed");
    const step0 = state.workflowSteps.get(`${runId}:0`)!;
    expect(step0.status).toBe("completed");
    expect(step0.credits_charged).toBe(STEP_COST);
    expect(state.dailyUsed).toBe(STEP_COST);
    expect(state.monthlyUsed).toBe(STEP_COST);
    expect(state.messages.size).toBe(1);
    const message = [...state.messages.values()][0];
    expect(message.content).toBe("Here is your homepage copy.");
    expect(message.credits_charged).toBe(STEP_COST);

    // No mid-execution backfill loop runs from THIS branch (only the
    // mid-execution resume path re-emits already-completed steps) — so
    // there should be exactly the two status events executeStep itself
    // emits: running, then completed.
    const statuses = sse.events.filter((e) => e.type === "workflow_step_status");
    expect(statuses).toHaveLength(2);
    expect(sse.events.filter((e) => e.type === "workflow_plan")).toHaveLength(1);
  });

  it("1c: a non-final step's clarifying question pauses mid-execution; both attempted steps are charged", async () => {
    const state = makeState({ planTier: "pro", dailyLimit: 750, monthlyLimit: 15000, planLimits: { workflow_steps: 10, workflow_cost: 40000 } });
    const fastify = makeFastify(state);
    const sse = makeFakeSSE();
    vi.mocked(planWorkflow).mockResolvedValueOnce({
      outcome: "workflow",
      steps: [
        { title: "Step A", category: "writing", detailedPrompt: "..." },
        { title: "Step B", category: "writing", detailedPrompt: "..." },
        { title: "Step C", category: "writing", detailedPrompt: "..." },
      ],
    });
    // Only non-final steps go through the JSON-envelope (completeOnce) path
    // — final steps stream and have no clarification branch at all.
    vi.mocked(completeOnce)
      .mockResolvedValueOnce(completeEnvelope("Step A output"))
      .mockResolvedValueOnce(clarifyEnvelope("Which tone?"));

    const result = await startWorkflow({
      fastify, sse, user: USER, conversationId: "conv-1", userMessageId: "msg-1",
      message: "do 3 things", contextBlock: "", systemPromptText: "sys", abortSignal: abortSignal(),
    });

    expect(result.handled).toBe(true);
    const [[runId, run]] = [...state.workflowRuns.entries()];
    expect(run.status).toBe("awaiting_clarification");
    expect(run.clarification_step_index).toBe(1);
    expect(run.current_step_index).toBe(1);

    const step0 = state.workflowSteps.get(`${runId}:0`)!;
    expect(step0.status).toBe("completed");
    expect(step0.credits_charged).toBe(STEP_COST);
    const step1 = state.workflowSteps.get(`${runId}:1`)!;
    // Charged even though it only asked a question — the model call was
    // real and consumed real tokens regardless of what it decided to say.
    expect(step1.status).toBe("awaiting_clarification");
    expect(step1.credits_charged).toBe(STEP_COST);
    const step2 = state.workflowSteps.get(`${runId}:2`)!;
    expect(step2.status).toBe("pending"); // inserted upfront, never reached

    expect(state.dailyUsed).toBe(STEP_COST * 2);
    expect(state.monthlyUsed).toBe(STEP_COST * 2);
  });

  it("1d: resuming a mid-execution pause carries prior credits forward without re-attributing them, and folds the Q&A into the retried step's prompt", async () => {
    // Realistic pre-existing state: this is what 1c's own run leaves
    // behind — step0's completed charge AND step1's charge for having
    // asked its question (both applied before the clarify-branch returns,
    // per executeStep's ordering) already reflected in the pools. dailyLimit
    // is raised well past that pre-existing usage: settlement itself has no
    // ceiling (it's a true-up, not a new admission check — see checkCredits.ts),
    // but the fresh RESERVE this resume attempts for step1's retry does check
    // against the cap, so the fixture has to leave room for it.
    const state = makeState({ planTier: "pro", dailyLimit: 5000, monthlyLimit: 15000, dailyUsed: STEP_COST * 2, monthlyUsed: STEP_COST * 2, planLimits: { workflow_steps: 10, workflow_cost: 40000 } });
    const fastify = makeFastify(state);
    const sse = makeFakeSSE();

    const steps = [
      { title: "Step A", category: "writing", categoryLabel: "Writing", detailedPrompt: "Prompt A" },
      { title: "Step B", category: "writing", categoryLabel: "Writing", detailedPrompt: "Prompt B" },
      { title: "Step C", category: "writing", categoryLabel: "Writing", detailedPrompt: "Prompt C" },
    ];
    const runId = makeWorkflowRun(state, {
      status: "awaiting_clarification",
      plan: { steps },
      clarification_question: "Which tone?",
      clarification_step_index: 1,
      current_step_index: 1,
    });
    makeWorkflowStep(state, runId, 0, {
      title: "Step A", category: "writing", category_label: "Writing", detailed_prompt: "Prompt A",
      status: "completed", output: "Step A output", routed_model: "test/model-1", credits_charged: STEP_COST,
    });
    makeWorkflowStep(state, runId, 1, {
      title: "Step B", category: "writing", category_label: "Writing", detailed_prompt: "Prompt B",
      status: "awaiting_clarification", credits_charged: STEP_COST,
    });
    makeWorkflowStep(state, runId, 2, {
      title: "Step C", category: "writing", category_label: "Writing", detailed_prompt: "Prompt C",
      status: "pending",
    });

    vi.mocked(completeOnce).mockResolvedValueOnce(completeEnvelope("Step B output (with tone)"));
    vi.mocked(streamCompletion).mockResolvedValueOnce(streamResult("Step C final output"));

    const run = state.workflowRuns.get(runId) as unknown as WorkflowRunRow;
    const result = await resumeWorkflow({
      fastify, sse, user: USER, conversationId: "conv-1", answer: "Friendly tone",
      run, contextBlock: "", systemPromptText: "sys", abortSignal: abortSignal(),
    });

    expect(result.handled).toBe(true);
    expect(state.workflowRuns.get(runId)!.status).toBe("completed");

    expect(state.workflowSteps.get(`${runId}:0`)!.credits_charged).toBe(STEP_COST); // untouched, not re-run
    const step1 = state.workflowSteps.get(`${runId}:1`)!;
    expect(step1.status).toBe("completed");
    expect(step1.output).toBe("Step B output (with tone)");
    const step2 = state.workflowSteps.get(`${runId}:2`)!;
    expect(step2.status).toBe("completed");

    // The Q&A was folded into the retried step's prompt.
    const call = vi.mocked(completeOnce).mock.calls[0][0];
    const userMsg = call.messages.find((m) => m.role === "user")!.content as string;
    expect(userMsg).toContain('You previously asked: "Which tone?"');
    expect(userMsg).toContain("The user's answer: Friendly tone");

    // THE core assertion: step0's original charge is carried forward, not
    // re-applied. Pools started at 1320 (step0 + step1's first, question-
    // asking charge from 1c); this resume adds step1's real retry (660)
    // and step2 (660) -- 1320 + 660 + 660 = 2640, never 660*4=2640... i.e.
    // never anything that implies step0 or step1's first charge repeated
    // a second time beyond what's asserted here.
    expect(state.dailyUsed).toBe(STEP_COST * 2 + STEP_COST + STEP_COST);
    expect(state.monthlyUsed).toBe(STEP_COST * 2 + STEP_COST + STEP_COST);

    // The displayed charge equals the FULL cost attributable to this
    // workflow: step0 (660) + step1's question-asking round-trip (660) +
    // step1's retry (660) + step2 (660) = 2640, matching the pools exactly.
    // Before the `lte` fix in resumeWorkflow this read 1980 — the
    // clarifying round-trip was genuinely charged but silently omitted
    // from what the user was shown.
    const message = [...state.messages.values()][0];
    expect(message.credits_charged).toBe(STEP_COST * 4);
    // Display must equal what the pools actually moved, with nothing
    // attributable to this run left out.
    expect(message.credits_charged).toBe(state.dailyUsed);
    expect(message.credits_charged).toBe(state.monthlyUsed);

    // The retried step's own row accumulates too, rather than the retry
    // silently overwriting what the clarifying attempt already cost.
    expect(step1.credits_charged).toBe(STEP_COST * 2);

    // Backfill emits exactly one "completed" for step0 (the only step
    // before clarification_step_index), before any new execution event.
    const stepEvents = sse.events
      .filter((e) => e.type === "workflow_step_status")
      .map((e) => e.data as { stepIndex: number; status: string });
    expect(stepEvents[0]).toMatchObject({ stepIndex: 0, status: "completed" });
    expect(stepEvents).toHaveLength(5); // backfill(1) + step1 running/completed(2) + step2 running/completed(2)
  });
});

describe("displayed charge integrity: what the user is shown equals what they were charged", () => {
  it("a normal (never-paused) workflow displays exactly the sum of its steps", async () => {
    const state = makeState({ planTier: "pro", dailyLimit: 5000, monthlyLimit: 15000, planLimits: { workflow_steps: 10, workflow_cost: 40000 } });
    const fastify = makeFastify(state);
    const sse = makeFakeSSE();
    vi.mocked(planWorkflow).mockResolvedValueOnce({
      outcome: "workflow",
      steps: [
        { title: "Step A", category: "writing", detailedPrompt: "..." },
        { title: "Step B", category: "writing", detailedPrompt: "..." },
      ],
    });
    vi.mocked(completeOnce).mockResolvedValueOnce(completeEnvelope("A output"));
    vi.mocked(streamCompletion).mockResolvedValueOnce(streamResult("B final"));

    await startWorkflow({
      fastify, sse, user: USER, conversationId: "conv-1", userMessageId: "msg-1",
      message: "two things", contextBlock: "", systemPromptText: "sys", abortSignal: abortSignal(),
    });

    const message = [...state.messages.values()][0];
    expect(message.credits_charged).toBe(STEP_COST * 2);
    expect(message.credits_charged).toBe(state.dailyUsed);
    expect(message.credits_charged).toBe(state.monthlyUsed);
  });

  it("a FAILED workflow displays no charge at all — it inserts no assistant message", async () => {
    const state = makeState({ planTier: "pro", dailyLimit: 5000, monthlyLimit: 15000, planLimits: { workflow_steps: 10, workflow_cost: 40000 } });
    const fastify = makeFastify(state);
    const sse = makeFakeSSE();
    vi.mocked(planWorkflow).mockResolvedValueOnce({
      outcome: "workflow",
      steps: [
        { title: "Step A", category: "writing", detailedPrompt: "..." },
        { title: "Step B", category: "video", detailedPrompt: "..." },
      ],
    });
    vi.mocked(selectModelCandidates).mockReset().mockResolvedValueOnce([PAID_MODEL]).mockResolvedValueOnce([]);
    vi.mocked(completeOnce).mockResolvedValueOnce(completeEnvelope("A output"));

    await startWorkflow({
      fastify, sse, user: USER, conversationId: "conv-1", userMessageId: "msg-1",
      message: "two things", contextBlock: "", systemPromptText: "sys", abortSignal: abortSignal(),
    });

    // Step A really did cost credits and the pools reflect that honestly —
    // but no assistant message exists, so there is no displayed number that
    // could misstate it. The failure surfaces as an SSE error instead.
    expect(state.dailyUsed).toBe(STEP_COST);
    expect(state.messages.size).toBe(0);
    expect(sse.events.some((e) => e.type === "error")).toBe(true);
    expect([...state.workflowRuns.values()][0].status).toBe("failed");
  });

  it("a CANCELLED workflow displays no charge — cancellation writes no message", async () => {
    const state = makeState({ planTier: "pro", dailyLimit: 5000, monthlyLimit: 15000, planLimits: { workflow_steps: 10, workflow_cost: 40000 } });
    const fastify = makeFastify(state);
    const runId = makeWorkflowRun(state, { conversation_id: "conv-1", status: "running" });

    await cancelActiveWorkflow(fastify, "conv-1");

    expect(state.workflowRuns.get(runId)!.status).toBe("cancelled");
    expect(state.messages.size).toBe(0);
    expect(state.dailyUsed).toBe(0);
    expect(state.monthlyUsed).toBe(0);
  });

  it("Free (workflow_steps: 0, migration 0032) never even attempts to plan — silent no-op, not a visible error", async () => {
    // Free's real entitlement is zero workflow steps (spec: no
    // workflows/agents on Free). The maxSteps<=0 guard in startWorkflow
    // returns {handled:false} before planWorkflow is ever called, so
    // chat.ts's caller falls through to ordinary single-shot chat — no
    // wasted planner call, no SSE error event of its own (an "error"
    // here would be the WRONG signal: this isn't a failure, it's simply
    // not a workflow request for this tier).
    const state = makeState({ planTier: "free", dailyLimit: 150, monthlyLimit: 3000, planLimits: { workflow_steps: 0, workflow_cost: 25000 } });
    const fastify = makeFastify(state);
    const sse = makeFakeSSE();

    const result = await startWorkflow({
      fastify, sse, user: { ...USER, planTier: "free" }, conversationId: "conv-1", userMessageId: "msg-1",
      message: "enormous", contextBlock: "", systemPromptText: "sys", abortSignal: abortSignal(),
    });

    expect(result).toEqual({ handled: false });
    expect(vi.mocked(planWorkflow)).not.toHaveBeenCalled();
    expect(state.dailyUsed).toBe(0);
    expect(state.monthlyUsed).toBe(0);
    expect(state.messages.size).toBe(0);
    expect(state.workflowSteps.size).toBe(0);
    expect(sse.events.length).toBe(0);
  });

  it("a plan too large for a paid user's per-workflow ceiling is rejected upfront, charging nothing", async () => {
    // Structural per-plan workflow-cost ceiling rejects the plan before any
    // step executes — distinct from the zero-step-budget case above: this
    // user genuinely has workflows (workflow_steps: 10), the PLAN itself is
    // just too expensive for the per-workflow ceiling (workflow_cost).
    const state = makeState({ planTier: "pro", dailyLimit: 750, monthlyLimit: 15000, planLimits: { workflow_steps: 10, workflow_cost: 40000 } });
    const fastify = makeFastify(state);
    const sse = makeFakeSSE();
    vi.mocked(planWorkflow).mockResolvedValueOnce({
      outcome: "workflow",
      // credit_cost_bands isn't seeded in this fake, so resolveWorkflowStepEstimate
      // always takes its error-fallback flat estimate of 50/step -> 900 * 50 = 45000 > 40000.
      steps: Array.from({ length: 900 }, (_, i) => ({ title: `S${i}`, category: "writing", detailedPrompt: "..." })),
    });

    await startWorkflow({
      fastify, sse, user: { ...USER, planTier: "pro" }, conversationId: "conv-1", userMessageId: "msg-1",
      message: "enormous", contextBlock: "", systemPromptText: "sys", abortSignal: abortSignal(),
    });

    expect(state.dailyUsed).toBe(0);
    expect(state.monthlyUsed).toBe(0);
    expect(state.messages.size).toBe(0);
    expect(state.workflowSteps.size).toBe(0);
    expect(sse.events.some((e) => e.type === "error")).toBe(true);
  });
});

describe("scenario 2: edit/regenerate cancellation", () => {
  // Mirrors handlers/chat.ts's inline decision exactly (there is no
  // exported unit to call — see that file's own comment). hardening.test.ts
  // pins the literal source expression this reproduces, so the two can't
  // silently drift apart unnoticed.
  async function simulateChatEntry(fastify: ReturnType<typeof makeFastify>, conversationId: string, regenerate: boolean) {
    const active = await getActiveWorkflow(fastify, conversationId);
    let resumable: WorkflowRunRow | null = null;
    if (active) {
      if (regenerate || active.status !== "awaiting_clarification") {
        await cancelActiveWorkflow(fastify, conversationId);
      } else {
        resumable = active;
      }
    }
    return { active, resumable };
  }

  it("2a: cancelling is scoped to one conversation and never touches terminal-status runs", async () => {
    const state = makeState();
    const fastify = makeFastify(state);
    const runA = makeWorkflowRun(state, { conversation_id: "conv-1", status: "awaiting_clarification" });
    const runB = makeWorkflowRun(state, { conversation_id: "conv-1", status: "completed" });
    const runC = makeWorkflowRun(state, { conversation_id: "conv-2", status: "running" });

    await cancelActiveWorkflow(fastify, "conv-1");

    expect(state.workflowRuns.get(runA)!.status).toBe("cancelled");
    expect(state.workflowRuns.get(runB)!.status).toBe("completed"); // filtered out by status, protected
    expect(state.workflowRuns.get(runC)!.status).toBe("running"); // different conversation
  });

  it("2b: regenerating always cancels, even an awaiting_clarification run", async () => {
    const state = makeState();
    const fastify = makeFastify(state);
    const runId = makeWorkflowRun(state, { conversation_id: "conv-1", status: "awaiting_clarification" });
    const { resumable } = await simulateChatEntry(fastify, "conv-1", true);
    expect(resumable).toBeNull();
    expect(state.workflowRuns.get(runId)!.status).toBe("cancelled");
  });

  it("2c: a non-regenerate edit on an actively running workflow still cancels it", async () => {
    const state = makeState();
    const fastify = makeFastify(state);
    const runId = makeWorkflowRun(state, { conversation_id: "conv-1", status: "running" });
    const { resumable } = await simulateChatEntry(fastify, "conv-1", false);
    expect(resumable).toBeNull();
    expect(state.workflowRuns.get(runId)!.status).toBe("cancelled");
  });

  it("2d: a non-regenerate message on an awaiting_clarification run stashes it as resumable instead of cancelling", async () => {
    const state = makeState();
    const fastify = makeFastify(state);
    const runId = makeWorkflowRun(state, { conversation_id: "conv-1", status: "awaiting_clarification" });
    const { resumable } = await simulateChatEntry(fastify, "conv-1", false);
    expect(resumable).not.toBeNull();
    expect(resumable!.id).toBe(runId);
    expect(state.workflowRuns.get(runId)!.status).toBe("awaiting_clarification"); // untouched
  });
});

describe("scenario 3: zero live candidates -> zero credit charge", () => {
  it("3a: zero candidates for a fresh single-step plan fails cleanly, with only the harmless upfront affordability check", async () => {
    const state = makeState({ planTier: "pro", dailyLimit: 750, monthlyLimit: 15000, planLimits: { workflow_steps: 10, workflow_cost: 40000 } });
    const fastify = makeFastify(state);
    const sse = makeFakeSSE();
    vi.mocked(planWorkflow).mockResolvedValueOnce({
      outcome: "workflow",
      steps: [{ title: "Generate a video", category: "video", detailedPrompt: "..." }],
    });
    vi.mocked(selectModelCandidates).mockReset().mockResolvedValueOnce([]);

    const result = await startWorkflow({
      fastify, sse, user: USER, conversationId: "conv-1", userMessageId: "msg-1",
      message: "make a video", contextBlock: "", systemPromptText: "sys", abortSignal: abortSignal(),
    });

    expect(result.handled).toBe(true);
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0].name).toBe("check_credits"); // upfront gate only -- nothing counter-moving
    expect(state.dailyUsed).toBe(0);
    expect(state.monthlyUsed).toBe(0);
    expect([...state.workflowRuns.values()][0].status).toBe("failed");
    expect([...state.workflowSteps.values()][0].status).toBe("failed");
    expect(sse.events.some((e) => e.type === "error")).toBe(true);
  });

  it("3b: the cleanest form -- resuming straight into a no-candidates step calls zero credit RPCs at all", async () => {
    const state = makeState({ planTier: "pro", dailyLimit: 750, monthlyLimit: 15000, planLimits: { workflow_steps: 10, workflow_cost: 40000 } });
    const fastify = makeFastify(state);
    const sse = makeFakeSSE();
    const steps = [{ title: "Step A", category: "video", categoryLabel: "Video", detailedPrompt: "..." }];
    const runId = makeWorkflowRun(state, {
      status: "awaiting_clarification", plan: { steps },
      clarification_question: "Q", clarification_step_index: 0, current_step_index: 0,
    });
    makeWorkflowStep(state, runId, 0, { category: "video", status: "awaiting_clarification" });
    vi.mocked(selectModelCandidates).mockReset().mockResolvedValueOnce([]);

    const run = state.workflowRuns.get(runId) as unknown as WorkflowRunRow;
    const result = await resumeWorkflow({
      fastify, sse, user: USER, conversationId: "conv-1", answer: "an answer",
      run, contextBlock: "", systemPromptText: "sys", abortSignal: abortSignal(),
    });

    expect(result.handled).toBe(true);
    // The mid-execution resume branch skips the upfront affordability
    // check entirely -- this is the strongest possible statement of the
    // invariant: literally zero credit RPCs of any kind.
    expect(state.rpcCalls).toHaveLength(0);
    expect(state.dailyUsed).toBe(0);
    expect(state.monthlyUsed).toBe(0);
    expect(state.workflowSteps.get(`${runId}:0`)!.status).toBe("failed");
    expect(state.workflowRuns.get(runId)!.status).toBe("failed");
  });

  it("3c: an earlier step's legitimate charge survives a later step having no candidates", async () => {
    const state = makeState({ planTier: "pro", dailyLimit: 750, monthlyLimit: 15000, planLimits: { workflow_steps: 10, workflow_cost: 40000 } });
    const fastify = makeFastify(state);
    const sse = makeFakeSSE();
    vi.mocked(planWorkflow).mockResolvedValueOnce({
      outcome: "workflow",
      steps: [
        { title: "Step A", category: "writing", detailedPrompt: "..." },
        { title: "Step B", category: "video", detailedPrompt: "..." },
      ],
    });
    vi.mocked(selectModelCandidates).mockReset().mockResolvedValueOnce([PAID_MODEL]).mockResolvedValueOnce([]);
    vi.mocked(completeOnce).mockResolvedValueOnce(completeEnvelope("Step A output"));

    const result = await startWorkflow({
      fastify, sse, user: USER, conversationId: "conv-1", userMessageId: "msg-1",
      message: "two things", contextBlock: "", systemPromptText: "sys", abortSignal: abortSignal(),
    });

    expect(result.handled).toBe(true);
    expect(state.dailyUsed).toBe(STEP_COST);
    expect(state.monthlyUsed).toBe(STEP_COST);
    const rpcNames = state.rpcCalls.map((c) => c.name);
    expect(rpcNames.filter((n) => n === "reserve_daily_credits")).toHaveLength(1); // step0 only
    expect(rpcNames.filter((n) => n === "consume_credits")).toHaveLength(1); // step0 only
  });
});

describe("scenario 4: stale-run reaping", () => {
  const STALE = 6 * 60 * 1000;
  const FRESH = 4 * 60 * 1000;

  it("4a: a 'running' run stale by 6 minutes is reaped to failed", async () => {
    const state = makeState();
    const fastify = makeFastify(state);
    const runId = makeWorkflowRun(state, { status: "running", updated_at: new Date(Date.now() - STALE).toISOString() });
    const result = await getActiveWorkflow(fastify, "conv-1");
    expect(result).toBeNull();
    expect(state.workflowRuns.get(runId)!.status).toBe("failed"); // the mutation, not just the null return
  });

  it("4b: a 4-minute-old 'running' run is returned untouched, not reaped", async () => {
    const state = makeState();
    const fastify = makeFastify(state);
    const runId = makeWorkflowRun(state, { status: "running", updated_at: new Date(Date.now() - FRESH).toISOString() });
    const result = await getActiveWorkflow(fastify, "conv-1");
    expect(result).not.toBeNull();
    expect(result!.id).toBe(runId);
    expect(state.workflowRuns.get(runId)!.status).toBe("running");
  });

  it("4c: a stale 'planning' run is reaped the same way as 'running'", async () => {
    const state = makeState();
    const fastify = makeFastify(state);
    const runId = makeWorkflowRun(state, { status: "planning", updated_at: new Date(Date.now() - STALE).toISOString() });
    const result = await getActiveWorkflow(fastify, "conv-1");
    expect(result).toBeNull();
    expect(state.workflowRuns.get(runId)!.status).toBe("failed");
  });

  it("4d: an 'awaiting_clarification' run is NEVER reaped, regardless of age", async () => {
    const state = makeState();
    const fastify = makeFastify(state);
    const runId = makeWorkflowRun(state, { status: "awaiting_clarification", updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
    const result = await getActiveWorkflow(fastify, "conv-1");
    expect(result).not.toBeNull();
    expect(state.workflowRuns.get(runId)!.status).toBe("awaiting_clarification");
  });

  it("4e: terminal-status rows are excluded regardless of age (the .in() filter itself protects them)", async () => {
    const state = makeState();
    const fastify = makeFastify(state);
    for (const status of ["completed", "failed", "cancelled"]) {
      makeWorkflowRun(state, { status, updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
    }
    const result = await getActiveWorkflow(fastify, "conv-1");
    expect(result).toBeNull();
  });
});

describe("scenario 5: the atomic-claim race in resumeWorkflow", () => {
  it("5a: two concurrent resumes on the same run execute exactly once, charged exactly once", async () => {
    const state = makeState({ planTier: "pro", dailyLimit: 750, monthlyLimit: 15000, planLimits: { workflow_steps: 10, workflow_cost: 40000 } });
    const fastify = makeFastify(state);
    const runId = makeWorkflowRun(state, {
      status: "awaiting_clarification",
      clarification_question: "Q",
      clarification_step_index: null,
    });
    vi.mocked(planWorkflow).mockResolvedValue({ outcome: "workflow", steps: [{ title: "Step A", category: "writing", detailedPrompt: "..." }] });
    vi.mocked(streamCompletion).mockResolvedValue(streamResult("Done"));

    const run = state.workflowRuns.get(runId) as unknown as WorkflowRunRow;
    const paramsFor = () => ({
      fastify, sse: makeFakeSSE(), user: USER, conversationId: "conv-1", answer: "answer",
      run, contextBlock: "", systemPromptText: "sys", abortSignal: abortSignal(),
    });

    const [resultA, resultB] = await Promise.all([resumeWorkflow(paramsFor()), resumeWorkflow(paramsFor())]);

    expect([resultA.handled, resultB.handled].filter(Boolean)).toHaveLength(1);
    expect([resultA.handled, resultB.handled].filter((h) => !h)).toHaveLength(1);
    expect(vi.mocked(streamCompletion)).toHaveBeenCalledTimes(1);
    expect(state.workflowSteps.size).toBe(1);
    expect(state.messages.size).toBe(1);
    expect(state.dailyUsed).toBe(STEP_COST);
    expect(state.monthlyUsed).toBe(STEP_COST);
    expect(state.workflowRuns.get(runId)!.status).toBe("completed");
  });

  it("5b, order A (cancel wins the race): a cancel ahead of a resume blocks the claim entirely -- nothing executes, nothing is charged", async () => {
    const state = makeState({ planTier: "pro", dailyLimit: 750, monthlyLimit: 15000, planLimits: { workflow_steps: 10, workflow_cost: 40000 } });
    const fastify = makeFastify(state);
    const runId = makeWorkflowRun(state, {
      status: "awaiting_clarification",
      clarification_question: "Q",
      clarification_step_index: null,
    });
    const run = state.workflowRuns.get(runId) as unknown as WorkflowRunRow;

    const [, resumeResult] = await Promise.all([
      cancelActiveWorkflow(fastify, "conv-1"),
      resumeWorkflow({
        fastify, sse: makeFakeSSE(), user: USER, conversationId: "conv-1", answer: "answer",
        run, contextBlock: "", systemPromptText: "sys", abortSignal: abortSignal(),
      }),
    ]);

    expect(resumeResult.handled).toBe(false);
    expect(state.workflowRuns.get(runId)!.status).toBe("cancelled");
    expect(vi.mocked(planWorkflow)).not.toHaveBeenCalled();
    expect(vi.mocked(selectModelCandidates)).not.toHaveBeenCalled();
    expect(state.dailyUsed).toBe(0);
    expect(state.monthlyUsed).toBe(0);
  });

  it("5b, order B (resume claims first, cancel lands during planning): the run stops before dispatching any step", async () => {
    // The resume wins the atomic claim, but then awaits planWorkflow --
    // and the cancel lands in that window. runSteps' pre-step cancellation
    // check then stops the run before the first step is ever dispatched,
    // so nothing is generated and nothing is charged. The cancelled state
    // also survives: no terminal write can overwrite it, because each one
    // is conditional on the run still being 'running'.
    const state = makeState({ planTier: "pro", dailyLimit: 750, monthlyLimit: 15000, planLimits: { workflow_steps: 10, workflow_cost: 40000 } });
    const fastify = makeFastify(state);
    const runId = makeWorkflowRun(state, {
      status: "awaiting_clarification",
      clarification_question: "Q",
      clarification_step_index: null,
    });
    const run = state.workflowRuns.get(runId) as unknown as WorkflowRunRow;
    vi.mocked(planWorkflow).mockResolvedValueOnce({ outcome: "workflow", steps: [{ title: "Step A", category: "writing", detailedPrompt: "..." }] });
    vi.mocked(streamCompletion).mockResolvedValueOnce(streamResult("Done"));

    const [resumeResult] = await Promise.all([
      resumeWorkflow({
        fastify, sse: makeFakeSSE(), user: USER, conversationId: "conv-1", answer: "answer",
        run, contextBlock: "", systemPromptText: "sys", abortSignal: abortSignal(),
      }),
      cancelActiveWorkflow(fastify, "conv-1"),
    ]);

    expect(resumeResult.handled).toBe(true);
    // The cancel is durable: no terminal write could overwrite it.
    expect(state.workflowRuns.get(runId)!.status).toBe("cancelled");
    // Nothing was generated, so nothing was charged.
    expect(vi.mocked(streamCompletion)).not.toHaveBeenCalled();
    expect(state.dailyUsed).toBe(0);
    expect(state.monthlyUsed).toBe(0);
    expect(state.messages.size).toBe(0);
  });

  it("5c: a cancel between steps stops the run before any further step is dispatched or charged", async () => {
    const state = makeState({ planTier: "pro", dailyLimit: 5000, monthlyLimit: 15000, planLimits: { workflow_steps: 10, workflow_cost: 40000 } });
    const fastify = makeFastify(state);
    const sse = makeFakeSSE();
    vi.mocked(planWorkflow).mockResolvedValueOnce({
      outcome: "workflow",
      steps: [
        { title: "Step A", category: "writing", detailedPrompt: "..." },
        { title: "Step B", category: "writing", detailedPrompt: "..." },
        { title: "Step C", category: "writing", detailedPrompt: "..." },
      ],
    });
    // Cancel the run from "another request" the instant step A finishes.
    vi.mocked(completeOnce).mockImplementationOnce(async () => {
      await cancelActiveWorkflow(fastify, "conv-1");
      return completeEnvelope("A output");
    });

    await startWorkflow({
      fastify, sse, user: USER, conversationId: "conv-1", userMessageId: "msg-1",
      message: "three things", contextBlock: "", systemPromptText: "sys", abortSignal: abortSignal(),
    });

    // Step B never ran: only the single step-A generation was dispatched.
    expect(vi.mocked(completeOnce)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(streamCompletion)).not.toHaveBeenCalled();
    // Only step A's credits were spent — cancellation stopped further cost.
    expect(state.dailyUsed).toBe(STEP_COST);
    expect(state.monthlyUsed).toBe(STEP_COST);
    // No assistant message: the run never reached a final step.
    expect(state.messages.size).toBe(0);
    expect([...state.workflowRuns.values()][0].status).toBe("cancelled");
  });
});
