import type { PlanTier } from "../shared-types.js";

export interface AuthedUser {
  id: string;
  email: string;
  planTier: PlanTier;
  orgId: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    user: AuthedUser;
    // Raw JSON body bytes, stashed by the custom content-type parser in
    // server.ts — needed only by the Razorpay webhook route to verify the
    // HMAC signature over the exact bytes Razorpay signed (parsed-then-
    // re-stringified JSON is not guaranteed to match byte-for-byte).
    rawBody?: Buffer;
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
