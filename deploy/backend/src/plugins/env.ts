import "dotenv/config";
import { z } from "zod";
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  FRONTEND_ORIGIN: z.string().url(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, "SUPABASE_SERVICE_ROLE_KEY is required"),
  OPENROUTER_API_KEY: z.string().min(1, "OPENROUTER_API_KEY is required"),
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  OPENROUTER_SITE_URL: z.string().url(),
  OPENROUTER_APP_NAME: z.string().default("SPLEX"),
  CORTEX_CLASSIFIER_MODEL_ID: z.string().min(1),
  // SPLEX Credits <-> USD conversion rate. Deliberately NOT a token=credit
  // mapping — see credits/realCost.ts. Tunable without changing what users see.
  CREDITS_PER_USD: z.coerce.number().positive().default(25_000),
  // Razorpay billing — deliberately optional. Deploys without payment keys
  // configured yet must still boot; routes/billing.ts checks all four are
  // present before constructing a Razorpay client and returns 503 rather
  // than crashing or accepting unverified webhooks if they're not. Any
  // one of these set without the others is still treated as "not
  // configured" — see isRazorpayConfigured. RAZORPAY_PRO_PLAN_ID comes
  // from running scripts/create-razorpay-plan.ts once real keys exist.
  RAZORPAY_KEY_ID: z.string().min(1).optional(),
  RAZORPAY_KEY_SECRET: z.string().min(1).optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1).optional(),
  RAZORPAY_PRO_PLAN_ID: z.string().min(1).optional(),
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
