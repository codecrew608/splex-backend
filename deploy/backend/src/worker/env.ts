import { z } from "zod";

// Same schema as plugins/env.ts, deliberately kept in sync by hand (not
// imported from there — that file's source is process.env via dotenv,
// which doesn't exist on Workers at all; env vars/secrets arrive as the
// `env` argument passed into fetch(request, env, ctx) instead). If the
// Fastify schema ever gains/drops a field, mirror the change here too.
const workerEnvSchema = z.object({
  FRONTEND_ORIGIN: z
    .string()
    .min(1, "FRONTEND_ORIGIN is required")
    .transform((val) =>
      val
        .split(",")
        .map((origin) => origin.trim().replace(/\/$/, ""))
        .filter(Boolean),
    )
    .pipe(z.array(z.string().url()).min(1, "FRONTEND_ORIGIN must contain at least one valid URL")),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, "SUPABASE_SERVICE_ROLE_KEY is required"),
  OPENROUTER_API_KEY: z.string().min(1, "OPENROUTER_API_KEY is required"),
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  OPENROUTER_SITE_URL: z.string().url(),
  OPENROUTER_APP_NAME: z.string().default("SPLEX"),
  CORTEX_CLASSIFIER_MODEL_ID: z.string().min(1),
  CREDITS_PER_USD: z.coerce.number().positive().default(20_000),
  // Optional here (unlike the Fastify schema, which defaults to a
  // loopback URL) — on Workers there is no "same machine" to default to;
  // an unset value means the intelligence service is genuinely
  // unreachable, and every call site already treats that as
  // non-fatal/skip (see worker/router.ts's OCR/embedding fallback).
  INTELLIGENCE_SERVICE_URL: z.string().url().optional(),
  LOG_LEVEL: z.string().default("info"),
});

export type WorkerConfig = z.infer<typeof workerEnvSchema>;

// Raw shape of the `env` object Cloudflare passes into fetch(). Every
// value arrives as a string (Worker secrets/vars are always strings) —
// z.coerce.number() above handles CREDITS_PER_USD.
export type RawWorkerEnv = Record<string, string | undefined>;

export class WorkerConfigError extends Error {}

export function parseWorkerEnv(env: RawWorkerEnv): WorkerConfig {
  const parsed = workerEnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new WorkerConfigError(`SPLEX Worker cannot start — invalid environment:\n${issues}`);
  }
  return parsed.data;
}
