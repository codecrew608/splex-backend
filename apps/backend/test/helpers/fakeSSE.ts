import type { SSEWriter } from "../../src/sse/writer.js";

// A recording double for SSEWriter, same "plain object, real mutable state"
// philosophy as fakeFastify.ts — not a mocking-library spy. Tests assert on
// the actual sequence/shape of events emitted (e.g. "exactly one backfilled
// completed status per already-done step, before any new execution event"),
// which a call-count spy on each individual method wouldn't make easy to
// express as a single ordered assertion.
export interface RecordedEvent {
  type: string;
  data?: unknown;
}

export interface FakeSSE extends SSEWriter {
  events: RecordedEvent[];
}

export function makeFakeSSE(): FakeSSE {
  const events: RecordedEvent[] = [];
  const record =
    (type: string) =>
    (data?: unknown): void => {
      events.push(data === undefined ? { type } : { type, data });
    };

  return {
    events,
    conversationCreated: record("conversation_created"),
    cortexStatus: record("cortex_status"),
    cortexDecision: record("cortex_decision"),
    token: record("token"),
    error: record("error"),
    done: record("done"),
    workflowPlan: record("workflow_plan"),
    workflowStepStatus: record("workflow_step_status"),
    workflowClarification: record("workflow_clarification"),
    researchStage: record("research_stage"),
    end: () => events.push({ type: "end" }),
  };
}
