import { getProStatus, handleCreateProWorkflow, handleStepProWorkflow, handleClarifyProWorkflow, handleGetProWorkflow, handleCancelProWorkflow } from "../../handlers/pro.js";
import type { WorkerCtx } from "../context.js";
import { asFastifyInstance } from "../context.js";
import type { AuthedUser } from "../../types/index.js";
import { respondWithResult, parseJsonBody, errorResponse } from "../http.js";

// HTTP adapter only — behaviour lives in handlers/pro.ts, shared verbatim
// with routes/pro.ts.
export function handleGetProStatus(ctx: WorkerCtx): Response {
  return respondWithResult(getProStatus(asFastifyInstance(ctx)));
}

export async function handleCreateProWorkflowWorker(request: Request, ctx: WorkerCtx, user: AuthedUser): Promise<Response> {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch {
    return errorResponse("Invalid JSON body.", 400);
  }
  return respondWithResult(await handleCreateProWorkflow(asFastifyInstance(ctx), user, (body ?? {}) as Record<string, unknown>));
}

export async function handleStepProWorkflowWorker(ctx: WorkerCtx, user: AuthedUser, workflowId: string): Promise<Response> {
  return respondWithResult(await handleStepProWorkflow(asFastifyInstance(ctx), user, workflowId));
}

export async function handleClarifyProWorkflowWorker(request: Request, ctx: WorkerCtx, user: AuthedUser, workflowId: string): Promise<Response> {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch {
    return errorResponse("Invalid JSON body.", 400);
  }
  return respondWithResult(await handleClarifyProWorkflow(asFastifyInstance(ctx), user, workflowId, (body ?? {}) as Record<string, unknown>));
}

export async function handleGetProWorkflowWorker(ctx: WorkerCtx, user: AuthedUser, workflowId: string): Promise<Response> {
  return respondWithResult(await handleGetProWorkflow(asFastifyInstance(ctx), user, workflowId));
}

export async function handleCancelProWorkflowWorker(ctx: WorkerCtx, user: AuthedUser, workflowId: string): Promise<Response> {
  return respondWithResult(await handleCancelProWorkflow(asFastifyInstance(ctx), user, workflowId));
}
