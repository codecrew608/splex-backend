import type { PlanTier } from "@splex/shared-types";

export interface AuthedUser {
  id: string;
  email: string;
  planTier: PlanTier;
  orgId: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    user: AuthedUser;
  }
}

// Row shape from public.model_registry. Backend-only — never send this
// object (or model_selected/openrouter_model_id) to a client.
export interface ModelRegistryRow {
  id: string;
  category: string;
  openrouter_model_id: string;
  variant: "free" | "paid";
  capability_score: number;
  context_length: number | null;
  cost_per_million_input: number;
  cost_per_million_output: number;
  is_active: boolean;
  priority: number;
  // Added in migration 0014 for cost-aware routing. Optional on the type
  // (not on the column) so any query that doesn't select them still
  // type-checks — the router treats missing values as "unknown" and falls
  // back to capability_score / neutral defaults rather than scoring 0.
  provider?: string | null;
  modality?: string;
  quality_score?: number | null;
  coding_score?: number | null;
  reasoning_score?: number | null;
  latency_score?: number;
  reliability_score?: number;
  free_tier_allowed?: boolean;
  pro_tier_allowed?: boolean;
}

// Row shape from public.model_health (migration 0014). Windowed counters —
// see that migration for why these describe roughly the last hour rather
// than all time.
export interface ModelHealthRow {
  model_id: string;
  success_count: number;
  failure_count: number;
  timeout_count: number;
  total_latency_ms: number;
  total_cost_usd: number;
  last_failure_at: string | null;
}

export interface OpenRouterUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// Row shape from public.files.
export interface FileRow {
  id: string;
  user_id: string;
  filename: string;
  file_type: string;
  mime_type: string | null;
  size_bytes: number;
  storage_path: string;
  processing_status: "uploaded" | "extracting" | "ocr_processing" | "embedding" | "ready" | "failed";
  extracted_text: string | null;
  error_message: string | null;
}
