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
  // "API 1" — the ONE OpenRouter credential Free (:free models) and
  // Starter/Paid (cheap paid-variant models) route through today. Required.
  OPENROUTER_API_KEY: z.string().min(1, "OPENROUTER_API_KEY is required"),
  // "API 2" — a SEPARATE OpenRouter credential reserved exclusively for
  // SPLEX Pro. NOT wired to any routing code (this task added the slot
  // only); Pro itself stays feature-flagged off. Free and Starter MUST
  // NEVER reach this credential — there is deliberately no code path that
  // reads it, and openRouterHeaders() (openrouter/client.ts) uses only
  // OPENROUTER_API_KEY. Optional, absent today, secret-only (never a
  // wrangler.jsonc plaintext var), same posture as the 5 Pro provider keys
  // below. See test/free-starter-failover.test.ts for the isolation pins.
  OPENROUTER_API_KEY_2: z.string().min(1).optional(),
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  OPENROUTER_SITE_URL: z.string().url(),
  OPENROUTER_APP_NAME: z.string().default("SPLEX"),
  CORTEX_CLASSIFIER_MODEL_ID: z.string().min(1),
  // Which model runs the Prompt Optimizer's semantic (Layer B) compression
  // call for Pro-tier requests — see optimizer/model.ts. Independently
  // configurable from CORTEX_CLASSIFIER_MODEL_ID (spec item 23: "never
  // hardcode a single provider permanently"), defaulted to the same model
  // since both are cheap, reliable, structured-output-friendly internal
  // calls with an identical cost profile.
  PROMPT_OPTIMIZER_MODEL_ID: z.string().min(1).default("qwen/qwen-2.5-72b-instruct"),
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
  // user's burst.
  //
  // RAISED 5 -> 20 (2026-09-07), from real production evidence. At 5%
  // against OpenRouter's genuine 50/day free allowance the arithmetic is
  // floor(floor(50 * 0.9) * 0.05) = 2 — every Free user got exactly TWO
  // OpenRouter-served messages per day before being pushed to the fallback
  // for everything else. That is not a fair share, it is a wall. A real
  // user hit it after 5 messages (of an advertised 50) and, combined with
  // a separate fallback bug, was locked out entirely.
  //
  // 20% gives 9/user/day, so the shared pool still supports ~5 fully-active
  // users concurrently — comfortably above current usage — while the Groq
  // fallback (far larger capacity, see GROQ_TOTAL_DAILY_CAPACITY below)
  // absorbs everything past it. The honest constraint underneath: 45
  // effective requests/day is simply a very small pool, and NO percentage
  // makes it serve many users at once. The real fix for scale is
  // OpenRouter balance; this is the best allocation of what exists today.
  OPENROUTER_PER_USER_SHARE_PCT: z.coerce.number().min(0.1).max(100).default(20),
  // --- Groq fallback (migration 0056) — Free AND Paid, see groq/fallback.ts ---
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
  // CORRECTED 1000 -> 3000 (2026-09-07). The original 1000 came from
  // reading `x-ratelimit-limit-requests: 1000` as a DAILY cap. It is not:
  // the same response carries `x-ratelimit-reset-requests: 1m26.4s` — a
  // rolling sub-minute window, not a day. Groq's real binding constraint is
  // tokens: 8,000 per minute (`x-ratelimit-reset-tokens: 577ms`).
  //
  // Honest derivation of the number below, stated as the estimate it is:
  // 8,000 TPM at a typical ~1,500-token chat turn is ~5.3 sustained
  // requests/minute, or ~7,600/day theoretical. 3,000 is deliberately well
  // under that (~40% utilisation), while being high enough that this
  // counter stops being the binding limit on a user's ADVERTISED
  // entitlement — which was the actual bug: at 1000, Free's slice capped a
  // user at 26 Groq-served messages/day against an advertised 50. Provider
  // rationing must never silently undercut what the plan promises; the
  // plan's own daily_requests limit should be what a user hits.
  //
  // Still ONE real, physical, shared ceiling covering BOTH tiers (see
  // groq/capacity.ts's resolveTierBudget for the split that can never
  // exceed it). The 20% buffer stays: Groq enforces its own limits
  // per-minute anyway, so this counter is a SPLEX fairness/spend policy,
  // not a safety mechanism standing between SPLEX and a real charge.
  GROQ_TOTAL_DAILY_CAPACITY: z.coerce.number().int().positive().default(3000),
  GROQ_SAFETY_BUFFER_PCT: z.coerce.number().min(0).max(90).default(20),
  // What fraction of the BUFFERED total (see above) is reserved for Paid —
  // Free gets the remainder. A policy choice, not a measured fact: Paid
  // traffic is expected to be far lower-volume than Free today, so a
  // minority share is generous per-user (see GROQ_PER_USER_SHARE_PCT_PAID
  // below) while still leaving the majority of the shared pool for Free's
  // higher volume.
  GROQ_PAID_SHARE_PCT: z.coerce.number().min(0).max(100).default(35),
  GROQ_PER_USER_SHARE_PCT: z.coerce.number().min(0.1).max(100).default(5),
  // Paid users get a much larger individual share of their tier's slice —
  // far fewer of them are expected, and losing service for a paying
  // customer costs more than for a Free one.
  GROQ_PER_USER_SHARE_PCT_PAID: z.coerce.number().min(0.1).max(100).default(25),
  // --- SPLEX Pro (₹799/month, multi-AI collaboration) — NOT LAUNCHED ---
  //
  // Single source of truth for whether Pro is reachable at all. Defaults
  // to false so a fresh deploy — this one included — never ships Pro
  // active by accident; someone has to deliberately flip it. Every Pro
  // route/handler calls pro/gate.ts's assertProEnabled(), which reads
  // this and refuses BEFORE touching any pro_* table, regardless of the
  // caller's plan_tier — this is the backend enforcement item 31/32 asks
  // for specifically because "the frontend must never control... without
  // backend authorization", and a hidden button is not that.
  SPLEX_PRO_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true")
    .pipe(z.boolean()),
  // Pro's 5 real provider credentials — every one optional, all absent
  // today (verified: no such key exists anywhere in this codebase or its
  // deployed secrets). pro/providers.ts checks each at call time: absent
  // -> the same "no credential configured" stub behavior as before this
  // ever existed; present -> a real API call. This is what lets a real
  // adapter activate by setting one secret, with zero further code
  // change or redeploy needed beyond that.
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_MODEL_ID: z.string().default("gpt-4o"),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  // PROVISIONAL default — verify against Anthropic's current model
  // catalogue before this is ever actually called; not something this
  // codebase can confirm live without a credential to test against.
  ANTHROPIC_MODEL_ID: z.string().default("claude-sonnet-4-5-20250929"),
  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_MODEL_ID: z.string().default("gemini-2.5-flash"),
  PERPLEXITY_API_KEY: z.string().min(1).optional(),
  PERPLEXITY_MODEL_ID: z.string().default("sonar-pro"),
  XAI_API_KEY: z.string().min(1).optional(),
  XAI_MODEL_ID: z.string().default("grok-4"),
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
