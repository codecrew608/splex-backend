import { z } from "zod";
import type { WorkerCtx } from "../context.js";
import type { AuthedUser } from "../../types/index.js";
import { jsonResponse, errorResponse } from "../http.js";

// Direct port of routes/account.ts's DELETE /account — same admin.deleteUser
// call, same reliance on the schema's existing ON DELETE CASCADE chain.
export async function handleDeleteAccount(ctx: WorkerCtx, user: AuthedUser): Promise<Response> {
  const { error } = await ctx.supabaseAdmin.auth.admin.deleteUser(user.id);
  if (error) {
    ctx.log.error({ error }, "account deletion failed");
    return jsonResponse({ message: "Failed to delete account. Please try again." }, 500);
  }
  return new Response(null, { status: 204 });
}

// Direct port of routes/account.ts's POST /account/profile.
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

export async function handleSaveProfile(request: Request, ctx: WorkerCtx, user: AuthedUser): Promise<Response> {
  const parsed = profileBodySchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) {
    return errorResponse("Please enter a valid name and date of birth.", 400);
  }

  const { error } = await ctx.supabaseAdmin
    .from("users")
    .update({ full_name: parsed.data.fullName, date_of_birth: parsed.data.dateOfBirth })
    .eq("id", user.id);

  if (error) {
    ctx.log.error({ error }, "failed to save onboarding profile");
    return errorResponse("Couldn't save your details. Please try again.", 500);
  }

  return new Response(null, { status: 204 });
}
