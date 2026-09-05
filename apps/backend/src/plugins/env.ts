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
  CREDITS_PER_USD: z.coerce.number().positive().default(120_000),
  // Local FastAPI sidecar — Tesseract OCR + BGE-small embeddings. See
  // services/intelligence/main.py.
  INTELLIGENCE_SERVICE_URL: z.string().url().default("http://127.0.0.1:8100"),
  // Bearer token for the sidecar above. Optional here because the default
  // URL is loopback-only, where main.py itself runs unauthenticated (only
  // this machine can reach it). If INTELLIGENCE_SERVICE_URL is ever
  // repointed at a network address, the sidecar refuses to start without a
  // matching token — see main.py's startup guard — so this must be set too.
  INTELLIGENCE_SERVICE_TOKEN: z.string().min(1).optional(),
  // Feedback-notification email (see email/sendEmail.ts). Entirely
  // optional: no provider was configured in this project before, and no
  // API key is invented here — feedback submission always succeeds
  // regardless of whether these are set; unset simply means the
  // best-effort notification email is skipped (logged, not an error).
  RESEND_API_KEY: z.string().min(1).optional(),
  // Sender identity Resend actually accepts requires a domain verified in
  // that account — this is NOT a secret, just a display value, safe to
  // leave at a placeholder until a real domain is verified.
  FEEDBACK_EMAIL_FROM: z.string().default("SPLEX Feedback <feedback@splex.app>"),
  // Recipient — never returned in any API response (see routes/feedback.ts).
  FEEDBACK_NOTIFICATION_EMAIL: z.string().email().default("openspace681@gmail.com"),
  // Razorpay webhook signature secret (handlers/razorpay.ts). Optional here
  // deliberately: it doesn't exist yet at implementation time (configured
  // later via `wrangler secret put` / local .env, never committed) and a
  // backend that refuses to boot without it would break local dev and every
  // other route in the meantime. The webhook handler itself fails closed —
  // rejects every request — when this is unset, rather than skipping
  // verification. Never confuse with RAZORPAY_KEY_SECRET (a different
  // secret, not used by this webhook at all).
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1).optional(),
  // Not secret (a plan identifier, not a credential) — safe as a real
  // default. Must come from server config, never a client-submitted value.
  RAZORPAY_STARTER_PLAN_ID: z.string().min(1).default("plan_TYEBWcXvja8WRM"),
  // Used by handlers/billing.ts::createSubscription to call Razorpay's
  // Create Subscription API (razorpay/client.ts). RAZORPAY_KEY_ID is not
  // secret — Razorpay's own Checkout widget expects the frontend to have
  // it too, so createSubscription's response includes it — but it's kept
  // optional-with-no-invented-value here for the same reason as the
  // webhook secret: it doesn't exist in this environment yet, and a
  // backend that refuses to boot without it would break every other route
  // in the meantime. RAZORPAY_KEY_SECRET is a true secret — Basic-Auth
  // credential for that same API call — never confuse it with
  // RAZORPAY_WEBHOOK_SECRET, a different secret entirely.
  RAZORPAY_KEY_ID: z.string().min(1).optional(),
  RAZORPAY_KEY_SECRET: z.string().min(1).optional(),
  LOG_LEVEL: z.string().default("info"),
});

export type Env = z.infer<typeof envSchema>;

declare module "fastify" {
  interface FastifyInstance {
    // Present only on the Workers runtime (see worker/context.ts); Node
    // keeps the process alive so background work needs no scheduler.
    scheduleBackground?: (work: Promise<unknown>) => void;
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
