import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

interface Bucket {
  count: number;
  resetAt: number;
}

// In-memory, single-process — same deployment-shape caveat as
// plugins/rateLimit.ts (would need a shared store if this backend is ever
// run as multiple instances). Keyed by "routeName:userId" rather than
// routeName alone, so each user's budget is independent.
const buckets = new Map<string, Bucket>();

// Periodic sweep so this map can't grow unbounded over the process's
// lifetime as distinct users hit rate-limited routes.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 60_000).unref();

// Per-USER (not per-IP) burst protection for the specific expensive
// endpoints the spec calls out — chat (which is also where every media
// capability actually executes; there's no separate route per
// capability), file processing, and status polling. This is a genuinely
// different concern from plugins/rateLimit.ts's IP-based flood guard and
// from the daily entitlement quotas (entitlements/index.ts): those bound
// *sustained volume per day*; this bounds *burst rate per minute*,
// independent of how much of the day's quota remains.
//
// Deliberately NOT built on @fastify/rate-limit's own per-route config for
// this: that plugin's keyGenerator runs at the hook phase it's registered
// for, and getting a per-user key requires request.user to already be
// set — which only happens inside fastify.authenticate, a route-specific
// preHandler. Relying on hook-ordering between a global plugin and a
// per-route preHandler to line up correctly is exactly the kind of subtle
// timing dependency worth avoiding for something access-control-adjacent;
// an explicit preHandler *array* (fastify.authenticate first, this
// second) makes the ordering a language guarantee instead of a plugin
// implementation detail.
export default fp(async function userRateLimitPlugin(fastify: FastifyInstance) {
  fastify.decorate(
    "rateLimitByUser",
    (routeName: string, max: number, windowMs: number) =>
      async function rateLimitPreHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
        const key = `${routeName}:${request.user.id}`;
        const now = Date.now();
        const bucket = buckets.get(key);

        if (!bucket || bucket.resetAt <= now) {
          buckets.set(key, { count: 1, resetAt: now + windowMs });
          return;
        }

        if (bucket.count >= max) {
          const retryAfterSeconds = Math.ceil((bucket.resetAt - now) / 1000);
          reply.header("Retry-After", String(retryAfterSeconds));
          await reply.code(429).send({ message: "You're doing that too fast — please slow down and try again shortly." });
          return;
        }

        bucket.count += 1;
      },
  );
});

declare module "fastify" {
  interface FastifyInstance {
    // Must run AFTER fastify.authenticate in a route's preHandler array —
    // reads request.user, which only that sets.
    rateLimitByUser: (
      routeName: string,
      max: number,
      windowMs: number,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
