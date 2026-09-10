import type { FastifyInstance } from "fastify";
import type { AuthedUser } from "../types/index.js";
import { ok, fail, type HandlerResult } from "./result.js";
import { isProEnabled, assertProAccess, ProUnavailableError } from "../pro/gate.js";
import { createProWorkflow } from "../pro/orchestrator.js";
import { executeWorkflowStep, resumeProWorkflowWithClarification, getProWorkflowStatus, cancelProWorkflow, type ExecutionStepResult, type ProWorkflowStatus, type CancelWorkflowResult } from "../pro/execution.js";

// Runtime-agnostic Pro handlers — written once, exposed by both
// routes/pro.ts (Fastify) and worker/routes/pro.ts (Worker), matching the
// existing handlers/result.ts adapter pattern (see that file's own header
// for why business logic is never written twice per HTTP runtime).

const PRO_PRICE_INR_PER_MONTH = 799;
const PRO_MONTHLY_CREDITS = 150000;
// Public product name for the Pro multi-AI orchestrator — the successor
// to the single-model "Cortex" router that powers Free/Starter. A name,
// not a version flag: nothing branches on it, so it's safe to surface in
// marketing copy without touching gating logic at all.
const PRO_ENGINE_NAME = "Cortex 2";

// GET /pro/status — deliberately UNAUTHENTICATED. This is the one Pro
// surface item 31 says must be reachable (so the frontend can render the
// "Coming Soon" card at all) while everything else stays refused. Carries
// only display-safe facts: price, credit allowance, and whether the flag
// is on — never a user's own eligibility, a provider name, or anything
// that would need auth to be honest.
export function getProStatus(fastify: FastifyInstance): HandlerResult<{
  enabled: boolean;
  status: "coming_soon" | "available";
  priceInrPerMonth: number;
  monthlyCredits: number;
  engineName: string;
}> {
  const enabled = isProEnabled(fastify);
  return ok({
    enabled,
    status: enabled ? "available" : "coming_soon",
    priceInrPerMonth: PRO_PRICE_INR_PER_MONTH,
    monthlyCredits: PRO_MONTHLY_CREDITS,
    engineName: PRO_ENGINE_NAME,
  });
}

interface CreateWorkflowBody {
  objective?: unknown;
}

// POST /pro/workflows — THE proof that disablement is enforced by the
// backend, not the UI. assertProAccess runs before anything else; with
// SPLEX_PRO_ENABLED=false (production's actual value right now) this
// returns 403 for every caller regardless of plan_tier, request body, or
// any other client-supplied value — there is no field in CreateWorkflowBody
// a caller could set to change that outcome.
export async function handleCreateProWorkflow(
  fastify: FastifyInstance,
  user: AuthedUser,
  body: CreateWorkflowBody,
): Promise<HandlerResult<{ complexity: string; workflowId?: string; taskCount?: number; message: string }>> {
  try {
    assertProAccess(fastify, user);
  } catch (err) {
    if (err instanceof ProUnavailableError) {
      return fail(err.message, 403);
    }
    throw err;
  }

  const objective = typeof body.objective === "string" ? body.objective.trim() : "";
  if (objective.length === 0 || objective.length > 4000) {
    return fail("objective is required and must be under 4000 characters.", 400);
  }

  const result = await createProWorkflow(fastify, user, objective);
  return ok(result, 201);
}

// POST /pro/workflows/:id/step — advances one Pro workflow by a single
// execution step (see pro/execution.ts's own header for why this is
// step-based rather than a single call that runs a workflow to
// completion). Idempotent to call repeatedly: a finished workflow just
// reports its already-terminal status back rather than erroring, so a
// caller can poll this on a fixed interval without tracking completion
// itself.
export async function handleStepProWorkflow(
  fastify: FastifyInstance,
  user: AuthedUser,
  workflowId: string,
): Promise<HandlerResult<ExecutionStepResult>> {
  try {
    assertProAccess(fastify, user);
  } catch (err) {
    if (err instanceof ProUnavailableError) {
      return fail(err.message, 403);
    }
    throw err;
  }

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workflowId)) {
    return fail("Invalid workflow id.", 400);
  }

  try {
    const result = await executeWorkflowStep(fastify, user, workflowId);
    return ok(result);
  } catch (err) {
    if (err instanceof Error && err.message === "Workflow not found.") {
      return fail("Workflow not found.", 404);
    }
    throw err;
  }
}

interface ClarifyWorkflowBody {
  answer?: unknown;
}

// POST /pro/workflows/:id/clarify — item 27's resume half. Answers a
// workflow currently WAITING_FOR_USER and immediately advances it one
// step (see resumeProWorkflowWithClarification's own doc comment) so the
// caller gets the same ExecutionStepResult shape /step already returns,
// rather than requiring two calls (answer, then step) for one logical
// action.
export async function handleClarifyProWorkflow(
  fastify: FastifyInstance,
  user: AuthedUser,
  workflowId: string,
  body: ClarifyWorkflowBody,
): Promise<HandlerResult<ExecutionStepResult>> {
  try {
    assertProAccess(fastify, user);
  } catch (err) {
    if (err instanceof ProUnavailableError) {
      return fail(err.message, 403);
    }
    throw err;
  }

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workflowId)) {
    return fail("Invalid workflow id.", 400);
  }

  const answer = typeof body.answer === "string" ? body.answer.trim() : "";
  if (answer.length === 0 || answer.length > 4000) {
    return fail("answer is required and must be under 4000 characters.", 400);
  }

  try {
    const result = await resumeProWorkflowWithClarification(fastify, user, workflowId, answer);
    return ok(result);
  } catch (err) {
    if (err instanceof Error && err.message === "Workflow not found.") {
      return fail("Workflow not found.", 404);
    }
    throw err;
  }
}

// POST /pro/workflows/:id/cancel — see cancelProWorkflow's own doc comment
// (pro/execution.ts) for exactly what cancellation does and does not stop.
// Idempotent like /step: cancelling an already-terminal workflow reports
// its current status back rather than erroring.
export async function handleCancelProWorkflow(
  fastify: FastifyInstance,
  user: AuthedUser,
  workflowId: string,
): Promise<HandlerResult<CancelWorkflowResult>> {
  try {
    assertProAccess(fastify, user);
  } catch (err) {
    if (err instanceof ProUnavailableError) {
      return fail(err.message, 403);
    }
    throw err;
  }

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workflowId)) {
    return fail("Invalid workflow id.", 400);
  }

  try {
    const result = await cancelProWorkflow(fastify, user, workflowId);
    return ok(result);
  } catch (err) {
    if (err instanceof Error && err.message === "Workflow not found.") {
      return fail("Workflow not found.", 404);
    }
    throw err;
  }
}

// GET /pro/workflows/:id — a basic read path for a workflow's current
// state (see getProWorkflowStatus's own doc comment for scope). The only
// GET among the Pro workflow routes, and — like every other one — scoped
// to the caller's own workflows via getProWorkflowStatus's own
// user_id-filtered query, never trusting the id alone.
export async function handleGetProWorkflow(
  fastify: FastifyInstance,
  user: AuthedUser,
  workflowId: string,
): Promise<HandlerResult<ProWorkflowStatus>> {
  try {
    assertProAccess(fastify, user);
  } catch (err) {
    if (err instanceof ProUnavailableError) {
      return fail(err.message, 403);
    }
    throw err;
  }

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workflowId)) {
    return fail("Invalid workflow id.", 400);
  }

  try {
    const result = await getProWorkflowStatus(fastify, user, workflowId);
    return ok(result);
  } catch (err) {
    if (err instanceof Error && err.message === "Workflow not found.") {
      return fail("Workflow not found.", 404);
    }
    throw err;
  }
}
