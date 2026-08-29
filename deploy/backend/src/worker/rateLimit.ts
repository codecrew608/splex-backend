import type { WorkerCtx } from "./context.js";

// Replaces plugins/userRateLimit.ts's in-memory Map for the Worker
// deployment — see db/migrations/0019_worker_rate_limiting.sql for why
// (no shared memory across a Workers isolate's requests, and Durable
// Objects are ruled out). Same call shape (routeName, max, windowMs) as
// the original so every route below reads identically to its Fastify
// counterpart. Trades a few ms of DB round-trip latency per rate-limited
// request for correctness without Durable Objects — see the migration
// audit's RISKS section for this tradeoff.
export async function rateLimitByUser(
  ctx: WorkerCtx,
  routeName: string,
  userId: string,
  max: number,
  windowMs: number,
): Promise<boolean> {
  const { data, error } = await ctx.supabaseAdmin.rpc("check_and_increment_rate_limit", {
    p_user_id: userId,
    p_route_name: routeName,
    p_max: max,
    p_window_seconds: Math.ceil(windowMs / 1000),
  });
  if (error) {
    // Fail open on a transport/RPC error (matches this codebase's existing
    // posture for non-security-critical infra — e.g. recordModelOutcome,
    // fetchGenerationCost — a rate-limiter outage must not take down every
    // route it protects). Credits/entitlement checks remain the real
    // spend-protection backstop regardless of this outcome.
    ctx.log.warn({ error, routeName, userId }, "check_and_increment_rate_limit RPC failed, failing open");
    return true;
  }
  return Boolean(data);
}
