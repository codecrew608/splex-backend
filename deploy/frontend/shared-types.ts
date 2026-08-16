// Shared contract between apps/backend and apps/web for the /chat SSE stream.
//
// HARD RULE: nothing in this file may carry a real model/provider identifier
// (an openrouter_model_id-shaped string, e.g. "qwen/qwen3-coder" or
// "deepseek/deepseek-r1") to the client. model_registry.openrouter_model_id,
// messages.routed_model, and cortex_decisions.model_selected are backend-only
// concepts. If a field here is ever tempted to hold one of those, it belongs
// in apps/backend/src/types instead, not here.

export type PlanTier = "free" | "starter" | "pro";

export type ComplexityLevel = "simple" | "medium" | "complex";

export type MessageRole = "user" | "assistant";

export interface ChatRequestBody {
  conversationId?: string;
  // Required unless regenerateMessageId is set (regeneration reuses the
  // last user message already stored server-side).
  message?: string;
  regenerateMessageId?: string;
  // Files already uploaded (see FileAttachment) and ready to reference in
  // this message — never raw file bytes over this endpoint.
  fileIds?: string[];
  // Only meaningful on the first message of a brand-new conversation:
  // attaches the new conversation to an existing project the caller owns,
  // instead of the default behavior of creating a fresh 1:1 project.
  projectId?: string;
}

export type FileProcessingStatus = "uploaded" | "extracting" | "ocr_processing" | "embedding" | "ready" | "failed";

// Client-facing view of a `files` row — enough for the Composer to render a
// staged/attached chip and know when a file is safe to reference in a
// message. Never carries extracted_text (irrelevant to the client, and
// potentially large).
export interface FileAttachment {
  id: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number;
  processingStatus: FileProcessingStatus;
  errorMessage: string | null;
}

export type CortexStatusStage =
  | "understanding"
  | "detecting_requirements"
  | "selecting_capability"
  | "executing";

export interface CortexStatusEventData {
  stage: CortexStatusStage;
  label: string;
}

// Client-safe view of a Cortex routing decision. Deliberately has no field
// that could hold model_registry.openrouter_model_id or
// cortex_decisions.model_selected.
export interface CortexDecisionPayload {
  intent: string;
  complexity: ComplexityLevel;
  capabilities: string[];
  categoryLabel: string;
  reason: string;
}

export interface ConversationCreatedEventData {
  conversationId: string;
}

export interface TokenEventData {
  delta: string;
}

export interface ErrorEventData {
  message: string;
}

export interface DoneEventData {
  messageId?: string;
  // Real DB id of the user message this turn — lets the client replace its
  // client-generated placeholder id, so a later "Edit" on that message can
  // actually find it server-side. Present on every completion variant
  // (success, blocked, partial) since the user message is always persisted
  // before any of those outcomes; absent only on regenerate (no new user
  // message that turn).
  userMessageId?: string;
  conversationId?: string;
  creditsCharged?: number;
  blocked?: boolean;
  partial?: boolean;
  // True when a multi-step workflow paused mid-run to ask the user
  // something — the authoritative signal for the frontend's paused state
  // (not "did a workflow_clarification event happen to arrive earlier in
  // this stream," which a page reload would lose).
  awaitingClarification?: boolean;
}

// Cortex's multi-step planner->executor orchestration (see
// apps/backend/src/cortex/workflow/). Never carries a raw category, a
// detailedPrompt, or a model id — categoryLabel only, same rule as
// CortexDecisionPayload.
export interface WorkflowPlanEventData {
  steps: Array<{ title: string; categoryLabel: string }>;
}

export interface WorkflowStepStatusEventData {
  stepIndex: number;
  status: "running" | "completed" | "failed";
  title: string;
}

export interface WorkflowClarificationEventData {
  question: string;
}

export type SplexSSEEvent =
  | { event: "conversation_created"; data: ConversationCreatedEventData }
  | { event: "cortex_status"; data: CortexStatusEventData }
  | { event: "cortex_decision"; data: CortexDecisionPayload }
  | { event: "token"; data: TokenEventData }
  | { event: "error"; data: ErrorEventData }
  | { event: "done"; data: DoneEventData }
  | { event: "workflow_plan"; data: WorkflowPlanEventData }
  | { event: "workflow_step_status"; data: WorkflowStepStatusEventData }
  | { event: "workflow_clarification"; data: WorkflowClarificationEventData };

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  intent: string | null;
  complexity: ComplexityLevel | null;
  creditsCharged: number | null;
  createdAt: string;
}

export interface Conversation {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
}
