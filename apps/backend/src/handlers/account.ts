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

// Accepts any string here — the real validation is isValidIanaTimezone
// below, run at call time rather than in the schema, so an invalid value
// can be silently dropped (best-effort sync) instead of failing the whole
// profile save over a field the user never directly typed.
const timezoneField = z.string().trim().min(1).max(100).optional();

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
  // Optional: the onboarding form captures this alongside name/DOB
  // (Intl.DateTimeFormat().resolvedOptions().timeZone, client-side) so a
  // brand-new user's reset boundary is right from their very first day —
  // see migration 0044 and syncTimezone below, which covers everyone else.
  timezone: timezoneField,
});

const timezoneBodySchema = z.object({ timezone: timezoneField });

// Real IANA-name validation, not just "is a non-empty string": an invalid
// zone reaching users.timezone would be caught by the DB's own
// pg_timezone_names safety net (migration 0044's user_timezone()) and just
// fall back to Asia/Kolkata there — but catching it here means the client
// gets an honest answer immediately rather than a value that silently
// never took effect. Intl throws RangeError for an unrecognized zone name;
// this works identically on both runtimes this backend ships to (Node and
// Workers), unlike Intl.supportedValuesOf, which isn't guaranteed on both.
export function isValidIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

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

  const update: { full_name: string; date_of_birth: string; timezone?: string } = {
    full_name: parsed.data.fullName,
    date_of_birth: parsed.data.dateOfBirth,
  };
  // Invalid/missing timezone just means this write skips that one column —
  // never a reason to fail the onboarding step itself (name + DOB are the
  // fields this screen exists to collect).
  if (parsed.data.timezone && isValidIanaTimezone(parsed.data.timezone)) {
    update.timezone = parsed.data.timezone;
  }

  const { error } = await fastify.supabaseAdmin.from("users").update(update).eq("id", userId);

  if (error) {
    fastify.log.error({ error }, "failed to save onboarding profile");
    return fail("Couldn't save your details. Please try again.", 500);
  }

  return noContent();
}

// Best-effort, low-frequency sync for users who already completed
// onboarding before this column existed (or whose browser timezone has
// genuinely changed since — e.g. relocated) — see Sidebar.tsx's one-time
// mount effect, migration 0044. Deliberately quiet on an invalid value
// (204 either way) rather than surfacing an error for something the user
// never directly interacted with.
export async function syncTimezone(fastify: FastifyInstance, userId: string, rawBody: unknown): Promise<HandlerResult> {
  const parsed = timezoneBodySchema.safeParse(rawBody);
  if (!parsed.success || !parsed.data.timezone || !isValidIanaTimezone(parsed.data.timezone)) {
    return noContent();
  }

  const { error } = await fastify.supabaseAdmin
    .from("users")
    .update({ timezone: parsed.data.timezone })
    .eq("id", userId);

  if (error) {
    fastify.log.error({ error }, "failed to sync timezone");
    return fail("Couldn't save your timezone. Please try again.", 500);
  }

  return noContent();
}
