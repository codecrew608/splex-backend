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
