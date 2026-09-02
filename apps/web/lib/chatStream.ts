import { createParser } from "eventsource-parser";
import type {
  ChatRequestBody,
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
import { BACKEND_URL } from "./backendUrl";

export interface ChatStreamHandlers {
  onConversationCreated: (data: ConversationCreatedEventData) => void;
  onCortexStatus: (data: CortexStatusEventData) => void;
  onCortexDecision: (data: CortexDecisionPayload) => void;
  onToken: (data: TokenEventData) => void;
  onError: (data: ErrorEventData) => void;
  onDone: (data: DoneEventData) => void;
  onWorkflowPlan: (data: WorkflowPlanEventData) => void;
  onWorkflowStepStatus: (data: WorkflowStepStatusEventData) => void;
  onWorkflowClarification: (data: WorkflowClarificationEventData) => void;
  onResearchStage: (data: ResearchStageEventData) => void;
}

export async function streamChat(
  body: ChatRequestBody,
  accessToken: string,
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${BACKEND_URL}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    handlers.onError({ message: "Couldn't reach SPLEX. Check your connection and try again." });
    return;
  }

  if (!response.ok || !response.body) {
    // 429 (rate limit — see apps/backend/src/plugins/userRateLimit.ts) is
    // common enough to be worth its own message rather than the generic
    // fallback; both carry a `{ message }` body the backend already wrote,
    // but that body was never read on this path before, so the fallback
    // is what most users would have seen for it.
    const message =
      response.status === 429
        ? "You're sending messages too fast — please wait a moment and try again."
        : response.status === 401
          ? // An expired or revoked session. "Something went wrong" is
            // actively unhelpful here: retrying cannot succeed, and the one
            // action that fixes it is the one the generic message hides.
            "Your session has expired. Please sign in again."
          : "Something went wrong. Please try again.";
    handlers.onError({ message });
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  const parser = createParser({
    onEvent(event) {
      if (!event.data) return;
      let data: unknown;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      switch (event.event) {
        case "conversation_created":
          handlers.onConversationCreated(data as ConversationCreatedEventData);
          break;
        case "cortex_status":
          handlers.onCortexStatus(data as CortexStatusEventData);
          break;
        case "cortex_decision":
          handlers.onCortexDecision(data as CortexDecisionPayload);
          break;
        case "token":
          handlers.onToken(data as TokenEventData);
          break;
        case "error":
          handlers.onError(data as ErrorEventData);
          break;
        case "done":
          handlers.onDone(data as DoneEventData);
          break;
        case "workflow_plan":
          handlers.onWorkflowPlan(data as WorkflowPlanEventData);
          break;
        case "workflow_step_status":
          handlers.onWorkflowStepStatus(data as WorkflowStepStatusEventData);
          break;
        case "workflow_clarification":
          handlers.onWorkflowClarification(data as WorkflowClarificationEventData);
          break;
        case "research_stage":
          handlers.onResearchStage(data as ResearchStageEventData);
          break;
        default:
          break;
      }
    },
  });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
    }
  } catch (err) {
    // FINDING (adversarial production-readiness audit): this loop had no
    // catch at all. reader.read() rejects on a mid-stream failure — the
    // connection drops, the server closes the response early — and,
    // routinely, on the Stop button: aborting the fetch makes the very
    // next read() reject with an AbortError. Either way the exception
    // used to propagate straight out of streamChat(), and useChatStream's
    // `await streamChat(...)` has no catch/finally of its own, so
    // setIsStreaming(false) never ran — the message stayed showing "..."
    // forever with no way to recover short of a reload. This is very
    // likely the exact bug the reported "stuck at •••" symptom was.
    // An explicit abort is not a failure — it must resolve quietly, not
    // show an error bubble over content the user deliberately cut short.
    if (signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
    handlers.onError({ message: "The connection was interrupted. Please try again." });
  }
}
