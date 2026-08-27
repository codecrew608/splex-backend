import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

// Deleting the auth.users row cascades through users -> projects ->
// conversations -> messages -> cortex_decisions, files -> file_chunks,
// subscriptions, usage_counters, credit_usage_logs, etc. — the ON DELETE
// CASCADE chain already defined in the schema does the actual cleanup, this
// route just triggers it via the admin API (only the service-role client can
// delete an auth user).
const accountRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.delete("/account", { preHandler: fastify.authenticate }, async (request, reply) => {
    const { error } = await fastify.supabaseAdmin.auth.admin.deleteUser(request.user.id);

    if (error) {
      fastify.log.error({ error }, "account deletion failed");
      return reply.code(500).send({ message: "Failed to delete account. Please try again." });
    }

    return reply.code(204).send();
  });

  fastify.post(
    "/account/profile",
    { preHandler: [fastify.authenticate, fastify.rateLimitByUser("account_profile", 5, 60_000)] },
    async (request, reply) => {
      const parsed = profileBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ message: "Please enter a valid name and date of birth." });
      }

      const { error } = await fastify.supabaseAdmin
        .from("users")
        .update({ full_name: parsed.data.fullName, date_of_birth: parsed.data.dateOfBirth })
        .eq("id", request.user.id);

      if (error) {
        fastify.log.error({ error }, "failed to save onboarding profile");
        return reply.code(500).send({ message: "Couldn't save your details. Please try again." });
      }

      return reply.code(204).send();
    },
  );
};

// One-time onboarding step (app/(app)/layout.tsx gates on full_name being
// null) — deliberately writes through the service-role client rather than
// letting the browser client write `users` directly, same as every other
// write to this table (see billing.ts's plan_tier flips) rather than
// trusting client-side RLS write access to be exactly right.
const MIN_AGE_YEARS = 13;
const profileBodySchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date")
    .refine((val) => {
      const dob = new Date(`${val}T00:00:00Z`);
      if (Number.isNaN(dob.getTime())) return false;
      const now = new Date();
      if (dob.getTime() > now.getTime()) return false;
      const ageMs = now.getTime() - dob.getTime();
      const ageYears = ageMs / (365.25 * 24 * 60 * 60 * 1000);
      return ageYears >= MIN_AGE_YEARS;
    }, `Must be a real date, not in the future, at least ${MIN_AGE_YEARS} years ago`),
});

export default accountRoutes;
