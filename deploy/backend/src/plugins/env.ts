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
  // What fraction of one model's (buffered) daily capacity a single user
  // may consume alone, before OTHER users are protected from that one
  // user's burst. 5% means at least 20 users could be fully active on the
  // same model on the same day before this becomes the binding constraint
  // for any of them — comfortably above SPLEX's current active user count,
  // with headroom to grow. A policy choice, not a measured fact.
  OPENROUTER_PER_USER_SHARE_PCT: z.coerce.number().min(0.1).max(100).default(5),
  // --- Groq fallback (migration 0056) — Free tier ONLY, see groq/fallback.ts ---
  //
  // Optional and unset by default: absence means the feature is simply
  // off (attemptGroqFallback returns null immediately), never a startup
  // failure — this is an emergency valve, not a required dependency.
  // Groq, Inc. (api.groq.com), confirmed NOT xAI's Grok — see
  // db/migrations/0056's header comment for how that was verified live
  // against the actual key.
  GROQ_API_KEY: z.string().min(1).optional(),
  GROQ_BASE_URL: z.string().url().default("https://api.groq.com/openai/v1"),
  // The one curated fallback model — see groq/fallback.ts's header for why
  // this deliberately does not replicate SPLEX's category-aware routing.
  GROQ_FALLBACK_MODEL: z.string().default("openai/gpt-oss-120b"),
  // Verified live against the actual provided key (real completion,
  // response headers): 1,000 requests/day, organization-wide, for the
  // openai/gpt-oss family. Same buffer pattern as OPENROUTER_FREE_DAILY_
  // CAPACITY above, but a wider default buffer (20% vs 10%) — deliberate,
  // not copied by mistake: this is a newly-added emergency valve with far
  // less production track record than the OpenRouter capacity system it
  // mirrors, so a more conservative margin is the right default until it
  // has real operational history.
  GROQ_FREE_DAILY_CAPACITY: z.coerce.number().int().positive().default(1000),
  GROQ_FREE_SAFETY_BUFFER_PCT: z.coerce.number().min(0).max(90).default(20),
  GROQ_PER_USER_SHARE_PCT: z.coerce.number().min(0.1).max(100).default(5),
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
