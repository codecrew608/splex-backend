// Single source of truth for per-route, per-user rate limits.
//
// These values previously existed twice — as scattered *_RATE_LIMIT consts
// across routes/*.ts and again as the RATE_LIMITS table in worker/index.ts.
// They happened to match when audited, but nothing enforced that: raising a
// limit in one stack and forgetting the other would silently leave one
// entry point more permissive than the other, which is a security-relevant
// divergence rather than a cosmetic one.
//
// Keyed by the same route names both stacks already pass to their rate
// limiter, so the bucket keys in the rate_limit_buckets table are unchanged
// and existing buckets keep working across this refactor.
export const RATE_LIMITS = {
  chat: { max: 20, windowMs: 60_000 },
  chat_truncate: { max: 30, windowMs: 60_000 },
  account_profile: { max: 5, windowMs: 60_000 },
  files_process: { max: 10, windowMs: 60_000 },
  projects_create: { max: 10, windowMs: 60_000 },
  billing_checkout: { max: 5, windowMs: 60_000 },
  billing_cancel: { max: 5, windowMs: 60_000 },
  media_status: { max: 30, windowMs: 60_000 },
} as const;

export type RateLimitedRoute = keyof typeof RATE_LIMITS;
