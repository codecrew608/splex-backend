import type { FastifyPluginAsync } from "fastify";
import { deleteAccount, saveProfile, syncTimezone, updateDisplayName, updateAvatarPath } from "../handlers/account.js";
import { RATE_LIMITS } from "../handlers/rateLimits.js";
import { sendResult } from "./sendResult.js";

// HTTP adapter only. All behaviour lives in handlers/account.ts, shared
// verbatim with the Worker entry point (worker/routes/account.ts) so the two
// can never drift.
const accountRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.delete("/account", { preHandler: fastify.authenticate }, async (request, reply) => {
    return sendResult(reply, await deleteAccount(fastify, request.user.id));
  });

  fastify.post(
    "/account/profile",
    {
      preHandler: [
        fastify.authenticate,
        fastify.rateLimitByUser(
          "account_profile",
          RATE_LIMITS.account_profile.max,
          RATE_LIMITS.account_profile.windowMs,
        ),
      ],
    },
    async (request, reply) => {
      return sendResult(reply, await saveProfile(fastify, request.user.id, request.body));
    },
  );

  fastify.patch(
    "/account/timezone",
    {
      preHandler: [
        fastify.authenticate,
        fastify.rateLimitByUser(
          "account_timezone",
          RATE_LIMITS.account_timezone.max,
          RATE_LIMITS.account_timezone.windowMs,
        ),
      ],
    },
    async (request, reply) => {
      return sendResult(reply, await syncTimezone(fastify, request.user.id, request.body));
    },
  );

  fastify.patch(
    "/account/display-name",
    {
      preHandler: [
        fastify.authenticate,
        fastify.rateLimitByUser(
          "account_display_name",
          RATE_LIMITS.account_display_name.max,
          RATE_LIMITS.account_display_name.windowMs,
        ),
      ],
    },
    async (request, reply) => {
      return sendResult(reply, await updateDisplayName(fastify, request.user.id, request.body));
    },
  );

  fastify.patch(
    "/account/avatar",
    {
      preHandler: [
        fastify.authenticate,
        fastify.rateLimitByUser("account_avatar", RATE_LIMITS.account_avatar.max, RATE_LIMITS.account_avatar.windowMs),
      ],
    },
    async (request, reply) => {
      return sendResult(reply, await updateAvatarPath(fastify, request.user.id, request.body));
    },
  );
};

export default accountRoutes;
