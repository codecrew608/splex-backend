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
  CREDITS_PER_USD: z.coerce.number().positive().default(120_000),
  // --- OpenRouter free-model capacity admission control (migration 0054) ---
  //
  // Verified live against the production key before choosing this default:
  // ten distinct :free models probed back-to-back returned
  // `X-RateLimit-Limit: 50` on every one that carried the header at all.
  // This is NOT a claim that every model shares one bucket — two models
  // (minimax-m2.7:free, minimax-m3:free) showed no such header — it is the
  // conservative per-model ceiling applied uniformly; see
  // db/migrations/0054's header comment and openrouter/capacity.ts for why
  // that is safe even where it is not precisely correct.
  //
  // UPDATE THIS the moment the intended $10 OpenRouter top-up is confirmed
  // AND re-verified live (bench/harness/quota_probe.py already does this) —
  // OpenRouter's own documented behavior is 1,000/day after that, but this
  // codebase's rule is to verify, not trust, before changing a number real
  // money/capacity planning depends on.
  OPENROUTER_FREE_DAILY_CAPACITY: z.coerce.number().int().positive().default(50),
  // Precautionary margin under the configured capacity above — protects
  // against the configured number being stale-too-high (OpenRouter lowers a
  // model's real ceiling without notice) or against imprecision in what
  // "one request" costs at the account level. A policy choice, not a
  // measured fact — stated as such here and in the deployment report.
  OPENROUTER_FREE_SAFETY_BUFFER_PCT: z.coerce.number().min(0).max(90).default(10),
  // RAISED 5 -> 20 (2026-09-07) — at 5% against OpenRouter's real 50/day
  // allowance this resolved to just 2 requests/user/day, which a real user
  // hit after 5 messages of an advertised 50. See plugins/env.ts's fuller
  // note on why no percentage makes a 45-request pool serve many users.
  OPENROUTER_PER_USER_SHARE_PCT: z.coerce.number().min(0.1).max(100).default(20),
  // --- Groq fallback (migration 0056) — Free AND Paid, see groq/fallback.ts ---
  // Same schema as the Fastify plugin above — see that file for the full
  // rationale (including how "Groq, not xAI Grok" was confirmed live, and
  // how the 2026-09-07 extension to Paid splits the one real shared limit).
  GROQ_API_KEY: z.string().min(1).optional(),
  GROQ_BASE_URL: z.string().url().default("https://api.groq.com/openai/v1"),
  GROQ_FALLBACK_MODEL: z.string().default("openai/gpt-oss-120b"),
  GROQ_TOTAL_DAILY_CAPACITY: z.coerce.number().int().positive().default(3000),
  GROQ_SAFETY_BUFFER_PCT: z.coerce.number().min(0).max(90).default(20),
  GROQ_PAID_SHARE_PCT: z.coerce.number().min(0).max(100).default(35),
  GROQ_PER_USER_SHARE_PCT: z.coerce.number().min(0.1).max(100).default(5),
  GROQ_PER_USER_SHARE_PCT_PAID: z.coerce.number().min(0.1).max(100).default(25),
  // SPLEX Pro (₹799/month) — NOT LAUNCHED. Same schema and rationale as
  // the Fastify plugin above; see that file for the full comment.
  SPLEX_PRO_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true")
    .pipe(z.boolean()),
  // Optional here (unlike the Fastify schema, which defaults to a
  // loopback URL) — on Workers there is no "same machine" to default to;
  // an unset value means the intelligence service is genuinely
  // unreachable, and every call site already treats that as
  // non-fatal/skip (see worker/router.ts's OCR/embedding fallback).
  INTELLIGENCE_SERVICE_URL: z.string().url().optional(),
  // Bearer token for the sidecar above. On Workers, unlike Fastify's
  // loopback default, INTELLIGENCE_SERVICE_URL (when set at all) always
  // points across the network — the sidecar refuses to start network-bound
  // without a token (see services/intelligence/main.py), so this is
  // effectively required whenever that URL is set. Optional in the schema
  // because "URL unset, service just not deployed" must remain valid.
  INTELLIGENCE_SERVICE_TOKEN: z.string().min(1).optional(),
  // Same schema as plugins/env.ts's identical fields — kept in sync by
  // hand, see this file's own top-of-file comment.
  RESEND_API_KEY: z.string().min(1).optional(),
  FEEDBACK_EMAIL_FROM: z.string().default("SPLEX Feedback <feedback@splex.app>"),
  FEEDBACK_NOTIFICATION_EMAIL: z.string().email().default("openspace681@gmail.com"),
  // Same schema as plugins/env.ts's identical fields — kept in sync by
  // hand, see this file's own top-of-file comment.
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1).optional(),
  RAZORPAY_STARTER_PLAN_ID: z.string().min(1).default("plan_TYEBWcXvja8WRM"),
  RAZORPAY_KEY_ID: z.string().min(1).optional(),
  RAZORPAY_KEY_SECRET: z.string().min(1).optional(),
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
