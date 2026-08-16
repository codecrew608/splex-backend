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
} from "@/shared-types";

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
}

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL as string;

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
    handlers.onError({ message: "Something went wrong. Please try again." });
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
        default:
          break;
      }
    },
  });

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.feed(decoder.decode(value, { stream: true }));
  }
}
