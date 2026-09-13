import type { FastifyInstance } from "fastify";
import type { AuthedUser } from "../types/index.js";

// SPLEX Pro (₹799/month). This is THE enforcement point: every Pro
// route/handler must call assertProEnabled() (or assertProAccess() once a
// real per-user Pro entitlement exists) before touching any pro_* table
// or making any provider call. Per this project's own explicit rule: "The
// frontend must never control... without backend authorization" and "the
// backend must enforce this independently [of the UI] — do not rely only
// on hiding a button."
//
// Two independent layers, checked in this order:
//   1. THE FLAG. Global kill switch, backed by system_flags.pro_enabled
//      (migration 0067) — a plain DB row, not a deploy-time config value.
//      This is deliberate: launching Pro is an admin-board action (a
//      single row flip, read fresh on every check, no cache — so it takes
//      effect on the very next request, no redeploy), not a code change.
//      When false — the default, and what production ships as — Pro is
//      unreachable for EVERY user regardless of plan_tier, including a
//      hypothetical user someone manually set to 'pro' in the database.
//      SPLEX_PRO_ENABLED (the old static env var) is no longer consulted
//      here; it stays declared in the env schemas but is otherwise dead.
//   2. THE TIER (once the flag is on). A request must come from an
//      authenticated user whose SERVER-RESOLVED plan_tier is 'pro' — the
//      same already-authenticated field every other tier-gated decision
//      in this codebase uses (see free-paid-isolation.test.ts's own
//      stated rule), never a client-supplied field.
//
// Both isProEnabled and assertProAccess are async now (a real DB read),
// which is why every call site in this codebase awaits them.

export class ProUnavailableError extends Error {
  readonly reason: "disabled" | "wrong_tier";
  constructor(reason: "disabled" | "wrong_tier") {
    super(
      reason === "disabled"
        ? "SPLEX Pro is not available yet."
        : "SPLEX Pro requires a Pro subscription.",
    );
    this.name = "ProUnavailableError";
    this.reason = reason;
  }
}

// Pure flag check — no user context needed. Use this for anything that
// must be refused even before authentication resolves a user (e.g. an
// unauthenticated status probe deciding what to advertise). Reads
// system_flags fresh every call — no in-process cache — so an admin
// toggling the switch takes effect on the very next request, not after
// some TTL.
export async function isProEnabled(fastify: FastifyInstance): Promise<boolean> {
  const { data, error } = await fastify.supabaseAdmin
    .from("system_flags")
    .select("enabled")
    .eq("key", "pro_enabled")
    .maybeSingle();
  if (error) {
    fastify.log.error({ error }, "isProEnabled: system_flags read failed — failing closed");
    return false;
  }
  return data?.enabled === true;
}

// The real guard. Throws ProUnavailableError (never returns false) so a
// caller cannot forget to check a boolean — every call site either gets
// past this line with a genuinely eligible user, or the request is
// already over. Call this FIRST, before any pro_* read or write.
export async function assertProAccess(fastify: FastifyInstance, user: AuthedUser): Promise<void> {
  if (!(await isProEnabled(fastify))) {
    throw new ProUnavailableError("disabled");
  }
  if (user.planTier !== "pro") {
    throw new ProUnavailableError("wrong_tier");
  }
}
