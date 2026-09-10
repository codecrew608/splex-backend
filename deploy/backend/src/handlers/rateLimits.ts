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
  account_timezone: { max: 5, windowMs: 60_000 },
  account_display_name: { max: 5, windowMs: 60_000 },
  account_avatar: { max: 5, windowMs: 60_000 },
  files_process: { max: 10, windowMs: 60_000 },
  projects_create: { max: 10, windowMs: 60_000 },
  billing_checkout: { max: 5, windowMs: 60_000 },
  billing_cancel: { max: 5, windowMs: 60_000 },
  billing_create_subscription: { max: 5, windowMs: 60_000 },
  media_status: { max: 30, windowMs: 60_000 },
  // SPLEX Pro — not launched. Low ceiling is intentional: this route is
  // refused (403) before it does any real work while SPLEX_PRO_ENABLED is
  // false, so the limit only matters as a floor against probing, not
  // against real usage that doesn't exist yet.
  pro_create_workflow: { max: 10, windowMs: 60_000 },
  // Higher ceiling than pro_create_workflow — a caller is expected to
  // call this repeatedly (poll-to-drive-forward, see pro/execution.ts's
  // own header) to advance a single workflow step by step, not once per
  // workflow. Still refused (403) before any real work while
  // SPLEX_PRO_ENABLED is false, same as every other pro_* route.
  pro_step_workflow: { max: 30, windowMs: 60_000 },
  pro_clarify_workflow: { max: 10, windowMs: 60_000 },
  // A read, so the most generous of the pro_* limits — a status-polling
  // caller is expected to check this more often than it advances the
  // workflow itself.
  pro_get_workflow: { max: 60, windowMs: 60_000 },
  feedback_submit: { max: 10, windowMs: 60_000 },
} as const;

export type RateLimitedRoute = keyof typeof RATE_LIMITS;
