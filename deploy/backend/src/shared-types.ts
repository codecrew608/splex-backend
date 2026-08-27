// Shared contract between apps/backend and apps/web for the /chat SSE stream.
//
// HARD RULE: nothing in this file may carry a real model/provider identifier
// (an openrouter_model_id-shaped string, e.g. "qwen/qwen3-coder" or
// "deepseek/deepseek-r1") to the client. model_registry.openrouter_model_id,
// messages.routed_model, and cortex_decisions.model_selected are backend-only
// concepts. If a field here is ever tempted to hold one of those, it belongs
// in apps/backend/src/types instead, not here.

export type PlanTier = "free" | "starter" | "pro";

// Server-resolved engine version — Free plans get v1 (baseline routing),
// Starter/Pro get v1.5 (full cost/quality/health-aware routing). Resolved
// ONLY server-side from the authenticated user's planTier (see
// apps/backend/src/cortex/version.ts's resolveCortexVersion) — a client
// never sends this, it only ever receives it back for display.
export type CortexVersion = "v1" | "v1.5";

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
  // Set only when this turn kicked off an async media job (video; PPT
  // later) that wasn't ready by the time the request returned — the
  // client-safe id of its generated_media row, for polling
  // GET /media/:id/status. Absent for every synchronous completion
  // (normal chat, image, audio all finish within the same request).
  pendingMediaId?: string;
  // Sources this turn's answer actually grounded on — set only when a
  // search genuinely happened (see WebSearchResult.searched in the
  // backend's research/types.ts). Absent (not empty array) for a normal
  // chat/image/audio/video/ppt turn, and absent even for a web_search-
  // routed turn if the model chose not to invoke the tool — the frontend
  // must never render a "Sources" section, or imply a search occurred,
  // when this is absent.
  citations?: Citation[];
  // The Cortex Routing disclosure panel's entire data source for this
  // turn — see CortexRoutingInfo's own doc comment. Absent on every
  // non-success completion (blocked/partial/error) — matches "no charge,
  // no disclosure": there's nothing genuine to disclose about a turn that
  // never actually generated anything.
  routing?: CortexRoutingInfo;
}

// url/title/snippet only — never the raw OpenRouter annotation object
// (offsets into model output, not meaningful once re-rendered).
export interface Citation {
  url: string;
  title: string;
  snippet: string;
}

// Client-safe summary of how THIS turn was actually routed — the Cortex
// Routing transparency panel's entire data source. Computed AFTER
// generation completes (from the model that actually served the request,
// post-fallback, not the first-choice candidate) so it's always accurate
// even when a fallback candidate ended up serving the turn.
//
// modelDisplayName is a curated friendly name resolved server-side (see
// apps/backend/src/cortex/modelDisplay.ts) — this field, like every other
// field in this file, must never carry a real openrouter_model_id,
// provider name, or raw routing score. `reason` is a short, deterministic,
// non-LLM-generated explanation (see modelDisplay.ts's
// explainModelSelection) — distinct from CortexDecisionPayload.reason,
// which explains the intent/category CLASSIFICATION, not the model pick.
export interface CortexRoutingInfo {
  cortexVersion: CortexVersion;
  categoryLabel: string;
  complexity: ComplexityLevel;
  modelDisplayName: string;
  reason: string;
  creditsCharged: number;
  responseTimeMs: number;
}

// Deep research's five real, independently-timed stages (see
// apps/backend/src/research/deepResearch.ts) — high-level progress only,
// never the underlying prompts, model ids, or raw tool calls.
export type ResearchStage = "planning" | "searching" | "reading_sources" | "cross_checking" | "writing_report";

export interface ResearchStageEventData {
  stage: ResearchStage;
}

// Cortex's multi-step planner->executor orchestration (see
// apps/backend/src/cortex/workflow/). Never carries a raw category, a
// detailedPrompt, or a model id — categoryLabel only, same rule as
// CortexDecisionPayload.
export interface WorkflowPlanEventData {
  steps: Array<{ title: string; categoryLabel: string }>;
  // Same engine version for every step in a run — resolved once from the
  // triggering user's planTier when the run starts (see
  // cortex/workflow/orchestrator.ts's RunCtx). Lets the Workflow panel
  // show "Cortex Engine v1.5 / Workflow · N steps" per the reference
  // design, without the frontend ever guessing at plan tier itself.
  cortexVersion: CortexVersion;
}

export interface WorkflowStepStatusEventData {
  stepIndex: number;
  status: "running" | "completed" | "failed";
  title: string;
  // Only set alongside status "completed" — the model that actually
  // served this step (post-fallback), as a curated friendly name (see
  // modelDisplay.ts's friendlyModelName). Never set for "running" (not
  // yet resolved to a final winner) or "failed" (nothing to disclose).
  modelDisplayName?: string;
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
  | { event: "workflow_clarification"; data: WorkflowClarificationEventData }
  | { event: "research_stage"; data: ResearchStageEventData };

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

// Backend-authoritative entitlement/usage state (GET /entitlements).
// Capability labels and counts only — never model ids, providers, or costs.
export type Capability =
  | "chat"
  | "workflow"
  | "image"
  | "video"
  | "audio"
  | "ppt"
  | "files"
  | "rag"
  | "projects"
  | "web_search"
  | "deep_research";

export interface QuotaState {
  capability: Capability;
  label: string;
  used: number;
  limit: number | null; // null = unlimited
  allowed: boolean;
}

export interface CreditBalance {
  used: number;
  limit: number | null;
  // False when the limit couldn't be resolved at all — the UI must show
  // "—" rather than inventing a percentage.
  available: boolean;
}

export interface EntitlementSnapshot {
  planTier: PlanTier;
  // Two independent ceilings (migration 0018) — monthly is the original
  // pool, daily is a separate day-scoped cap on top of it. Both must pass
  // for a request to proceed; either can be the one that's exhausted.
  credits: CreditBalance;
  dailyCredits: CreditBalance;
  quotas: QuotaState[];
}
