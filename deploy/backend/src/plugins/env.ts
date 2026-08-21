import "dotenv/config";
import { z } from "zod";
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  // Comma-separated list of allowed origins (usually just one). A single
  // exact-string mismatch here — wrong domain, stray trailing slash, http
  // vs https — silently fails CORS on every backend request with no
  // helpful error client-side, just a blocked-by-CORS message in devtools.
  // Accepting a list (trimmed, trailing slash stripped) rather than one
  // strict URL makes it possible to list more than one candidate while
  // confirming which deployment URL is actually live, instead of the app
  // being fully broken on a guess.
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
  // SPLEX Credits <-> USD conversion rate. Deliberately NOT a token=credit
  // mapping — see credits/realCost.ts. Tunable without changing what users see.
  CREDITS_PER_USD: z.coerce.number().positive().default(20_000),
  // Local FastAPI sidecar — Tesseract OCR + BGE-small embeddings. See
  // services/intelligence/main.py.
  INTELLIGENCE_SERVICE_URL: z.string().url().default("http://127.0.0.1:8100"),
  LOG_LEVEL: z.string().default("info"),
});

export type Env = z.infer<typeof envSchema>;

declare module "fastify" {
  interface FastifyInstance {
    config: Env;
  }
}

export default fp(async function envPlugin(fastify: FastifyInstance) {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    // Fail fast and loud. A backend that boots with silently-empty secrets
    // is worse than one that refuses to start.
    // eslint-disable-next-line no-console
    console.error(`\nSPLEX backend cannot start — invalid environment:\n${issues}\n`);
    process.exit(1);
  }
  fastify.decorate("config", parsed.data);
});
