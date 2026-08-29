import type { FastifyReply } from "fastify";
import type {
  ConversationCreatedEventData,
  CortexStatusEventData,
  CortexDecisionPayload,
  TokenEventData,
  ErrorEventData,
  DoneEventData,
  WorkflowPlanEventData,
  WorkflowStepStatusEventData,
  WorkflowClarificationEventData,
  ResearchStageEventData,
} from "@splex/shared-types";

// Public surface every caller (chat.ts, mediaGeneration.ts,
// research/handler.ts, cortex/workflow/orchestrator.ts) depends on —
// extracted so those call sites can accept either this Fastify-backed
// writer or the Worker's Web Streams-backed one (worker/sse.ts) without
// changing a single line of the business logic that already takes an
// `sse` param. Not a wire-format change: both implementations emit the
// identical `event: X\ndata: Y\n\n` frames.
export interface SSEWriter {
  conversationCreated(data: ConversationCreatedEventData): void;
  cortexStatus(data: CortexStatusEventData): void;
  cortexDecision(data: CortexDecisionPayload): void;
  token(data: TokenEventData): void;
  error(data: ErrorEventData): void;
  done(data: DoneEventData): void;
  workflowPlan(data: WorkflowPlanEventData): void;
  workflowStepStatus(data: WorkflowStepStatusEventData): void;
  workflowClarification(data: WorkflowClarificationEventData): void;
  researchStage(data: ResearchStageEventData): void;
  end(): void;
}

// Thin, typed wrapper over fastify-sse-v2's reply.sse(). Keeping every event
// name + payload shape funneled through here (backed by the shared types)
// is the second line of defense — beyond the type system — against a raw
// model id ever getting hand-serialized into an SSE frame somewhere else.
export class SplexSSEWriter implements SSEWriter {
  constructor(private readonly reply: FastifyReply) {}

  conversationCreated(data: ConversationCreatedEventData) {
    this.reply.sse({ event: "conversation_created", data: JSON.stringify(data) });
  }

  cortexStatus(data: CortexStatusEventData) {
    this.reply.sse({ event: "cortex_status", data: JSON.stringify(data) });
  }

  cortexDecision(data: CortexDecisionPayload) {
    this.reply.sse({ event: "cortex_decision", data: JSON.stringify(data) });
  }

  token(data: TokenEventData) {
    this.reply.sse({ event: "token", data: JSON.stringify(data) });
  }

  error(data: ErrorEventData) {
    this.reply.sse({ event: "error", data: JSON.stringify(data) });
  }

  done(data: DoneEventData) {
    this.reply.sse({ event: "done", data: JSON.stringify(data) });
  }

  workflowPlan(data: WorkflowPlanEventData) {
    this.reply.sse({ event: "workflow_plan", data: JSON.stringify(data) });
  }

  workflowStepStatus(data: WorkflowStepStatusEventData) {
    this.reply.sse({ event: "workflow_step_status", data: JSON.stringify(data) });
  }

  workflowClarification(data: WorkflowClarificationEventData) {
    this.reply.sse({ event: "workflow_clarification", data: JSON.stringify(data) });
  }

  researchStage(data: ResearchStageEventData) {
    this.reply.sse({ event: "research_stage", data: JSON.stringify(data) });
  }

  end() {
    this.reply.sseContext.source.end();
  }
}
