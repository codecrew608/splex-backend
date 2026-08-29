import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type HandlerResult, noContent, fail } from "./result.js";

// One-time onboarding step (app/(app)/layout.tsx gates on full_name being
// null). Writes through the service-role client rather than letting the
// browser client write `users` directly, same as every other write to that
// table (see billing.ts's plan_tier flips) rather than trusting client-side
// RLS write access to be exactly right.
//
// This schema was previously duplicated byte-for-byte between
// routes/account.ts and worker/routes/account.ts — including the age
// refinement — so a change to the minimum age or the date rules had to be
// made in two places to take effect on both entry points.
const MIN_AGE_YEARS = 13;

export const profileBodySchema = z.object({
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

// Deleting the auth.users row cascades through users -> projects ->
// conversations -> messages -> cortex_decisions, files -> file_chunks,
// subscriptions, usage_counters, credit_usage_logs, etc. — the ON DELETE
// CASCADE chain already defined in the schema does the actual cleanup; this
// only triggers it via the admin API (only the service-role client can
// delete an auth user).
export async function deleteAccount(fastify: FastifyInstance, userId: string): Promise<HandlerResult> {
  const { error } = await fastify.supabaseAdmin.auth.admin.deleteUser(userId);
  if (error) {
    fastify.log.error({ error }, "account deletion failed");
    return fail("Failed to delete account. Please try again.", 500);
  }
  return noContent();
}

export async function saveProfile(
  fastify: FastifyInstance,
  userId: string,
  rawBody: unknown,
): Promise<HandlerResult> {
  const parsed = profileBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("Please enter a valid name and date of birth.", 400);
  }

  const { error } = await fastify.supabaseAdmin
    .from("users")
    .update({ full_name: parsed.data.fullName, date_of_birth: parsed.data.dateOfBirth })
    .eq("id", userId);

  if (error) {
    fastify.log.error({ error }, "failed to save onboarding profile");
    return fail("Couldn't save your details. Please try again.", 500);
  }

  return noContent();
}
