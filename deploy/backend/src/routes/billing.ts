import type { FastifyPluginAsync } from "fastify";
import { fakeCheckout, fakeCancel, createSubscription } from "../handlers/billing.js";
import { RATE_LIMITS } from "../handlers/rateLimits.js";
import { sendResult } from "./sendResult.js";

// HTTP adapter only. Behaviour lives in handlers/billing.ts, shared verbatim
// with the Worker entry point (worker/routes/billing.ts).
const billingRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    "/billing/fake-checkout",
    {
      preHandler: [
        fastify.authenticate,
        fastify.rateLimitByUser("billing_checkout", RATE_LIMITS.billing_checkout.max, RATE_LIMITS.billing_checkout.windowMs),
      ],
    },
    async (request, reply) => sendResult(reply, await fakeCheckout(fastify, request.user.id)),
  );

  fastify.post(
    "/billing/fake-cancel",
    {
      preHandler: [
        fastify.authenticate,
        fastify.rateLimitByUser("billing_cancel", RATE_LIMITS.billing_cancel.max, RATE_LIMITS.billing_cancel.windowMs),
      ],
    },
    async (request, reply) => sendResult(reply, await fakeCancel(fastify, request.user.id)),
  );

  fastify.post(
    "/billing/create-subscription",
    {
      preHandler: [
        fastify.authenticate,
        fastify.rateLimitByUser(
          "billing_create_subscription",
          RATE_LIMITS.billing_create_subscription.max,
          RATE_LIMITS.billing_create_subscription.windowMs,
        ),
      ],
    },
    async (request, reply) => sendResult(reply, await createSubscription(fastify, request.user.id)),
  );
};

export default billingRoutes;
