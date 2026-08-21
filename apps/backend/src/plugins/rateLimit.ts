import fp from "fastify-plugin";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";

// Global, per-IP flood/DoS baseline — applies to every route, including
// unauthenticated ones (health, and a request that never gets past
// fastify.authenticate). Deliberately loose: this is not the mechanism
// that protects per-capability spend (see userRateLimit.ts for that,
// applied per-route on top of this) — it exists so a raw script hammering
// the backend can't exhaust the event loop or the connection pool before
// auth even has a chance to reject it.
//
// In-memory store (the plugin's default) — correct for this backend's
// actual deployment shape (DEPLOYMENT.md: one long-lived Node process, no
// mention of horizontal scaling). Would under-count across multiple
// instances behind a load balancer; if this backend is ever scaled
// horizontally, this needs a shared store (the plugin supports a `redis`
// option for exactly that) — noted here so it isn't silently wrong later.
export default fp(async function rateLimitPlugin(fastify: FastifyInstance) {
  await fastify.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    // Fastify's default IP resolution already honors trustProxy config;
    // no custom keyGenerator needed for this IP-level baseline.
    //
    // MUST return an Error with .statusCode set, not a plain object — the
    // plugin does `throw errorResponseBuilder(...)` internally (see its
    // source: `throw params.errorResponseBuilder(req, respCtx)`), and
    // Fastify's default error handler only honors a thrown value's own
    // statusCode; a plain object with no statusCode falls back to 500.
    // Verified live: an earlier plain-object version of this builder
    // produced 500s instead of 429s under real load, caught only by
    // actually hammering a running server rather than by typecheck/build.
    errorResponseBuilder: (_req, context) => {
      const err = new Error("Too many requests, please slow down.") as Error & { statusCode: number };
      err.statusCode = context.statusCode;
      return err;
    },
  });
});
