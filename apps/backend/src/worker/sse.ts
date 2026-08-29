import type { SSEWriter } from "../sse/writer.js";
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

// Web Streams equivalent of sse/writer.ts's SplexSSEWriter — same public
// method surface (implements the shared SSEWriter interface, so every
// existing caller — chat.ts's logic as ported into worker/router.ts,
// mediaGeneration.ts, research/handler.ts, orchestrator.ts — works
// against either implementation unchanged), same exact wire format
// (`event: X\ndata: Y\n\n`), so the frontend's SSE parser
// (lib/chatStream.ts / eventsource-parser) needs zero changes.
export class WorkerSSEWriter implements SSEWriter {
  private readonly encoder = new TextEncoder();

  constructor(private readonly controller: ReadableStreamDefaultController<Uint8Array>) {}

  private write(event: string, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    try {
      this.controller.enqueue(this.encoder.encode(frame));
    } catch {
      // Controller already closed (client disconnected) — same
      // fire-and-forget tolerance Fastify's reply.sse() has once the
      // underlying socket is gone; never throw out of an SSE write.
    }
  }

  conversationCreated(data: ConversationCreatedEventData) {
    this.write("conversation_created", data);
  }
  cortexStatus(data: CortexStatusEventData) {
    this.write("cortex_status", data);
  }
  cortexDecision(data: CortexDecisionPayload) {
    this.write("cortex_decision", data);
  }
  token(data: TokenEventData) {
    this.write("token", data);
  }
  error(data: ErrorEventData) {
    this.write("error", data);
  }
  done(data: DoneEventData) {
    this.write("done", data);
  }
  workflowPlan(data: WorkflowPlanEventData) {
    this.write("workflow_plan", data);
  }
  workflowStepStatus(data: WorkflowStepStatusEventData) {
    this.write("workflow_step_status", data);
  }
  workflowClarification(data: WorkflowClarificationEventData) {
    this.write("workflow_clarification", data);
  }
  researchStage(data: ResearchStageEventData) {
    this.write("research_stage", data);
  }

  end() {
    try {
      this.controller.close();
    } catch {
      // Already closed (e.g. client disconnect fired cancel() first) — fine.
    }
  }
}

// Builds a `{ writer, response }` pair — writer.* calls enqueue SSE frames,
// and `response` is what the Worker's fetch() handler returns immediately
// (streaming starts as soon as the first chunk is enqueued, exactly like
// Fastify's reply.sse() begins flushing on the first event). `onCancel`
// fires when the client disconnects mid-stream — the Worker-runtime
// equivalent of Fastify's `request.raw.on("close", ...)` in chat.ts,
// which aborts the in-flight OpenRouter fetch rather than letting it run
// to completion for a client that's already gone.
export function createSSEStream(onCancel?: () => void): { writer: WorkerSSEWriter; response: Response } {
  let writer!: WorkerSSEWriter;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      writer = new WorkerSSEWriter(controller);
    },
    cancel() {
      onCancel?.();
    },
  });
  const response = new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
  return { writer, response };
}
