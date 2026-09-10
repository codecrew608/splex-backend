import type { FastifyInstance } from "fastify";
import type { AuthedUser } from "../types/index.js";

// SPLEX Pro (₹799/month) — NOT LAUNCHED. This is THE enforcement point:
// every Pro route/handler must call assertProEnabled() (or
// assertProAccess() once a real per-user Pro entitlement exists) before
// touching any pro_* table or making any provider call. Per this
// project's own explicit rule: "The frontend must never control...
// without backend authorization" and "the backend must enforce this
// independently [of the UI] — do not rely only on hiding a button."
//
// Two independent layers, checked in this order:
//   1. THE FLAG (SPLEX_PRO_ENABLED). Global kill switch. When false —
//      which is the default, and is what production is set to right now
//      — Pro is unreachable for EVERY user regardless of plan_tier,
//      including a hypothetical user someone manually set to 'pro' in
//      the database. This is deliberate: a single config flip is the
//      only way Pro ever becomes reachable, not a combination of DB edits
//      that could each look individually correct.
//   2. THE TIER (once the flag is on). A request must come from an
//      authenticated user whose SERVER-RESOLVED plan_tier is 'pro' — the
//      same already-authenticated field every other tier-gated decision
//      in this codebase uses (see free-paid-isolation.test.ts's own
//      stated rule), never a client-supplied field.
//
// Currently unreachable in practice: nobody has plan_tier='pro' (migration
// 0061 freed that value; nothing grants it yet — there is no checkout,
// webhook, or admin action that sets it, by design, per this phase's own
// "do not allow checkout/upgrade into Pro" requirement). Layer 1 alone
// already makes Pro unreachable; layer 2 is defense in depth for the day
// a real subscription flow exists and the flag gets flipped before that
// flow is actually wired correctly.

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
// unauthenticated status probe deciding what to advertise).
export function isProEnabled(fastify: FastifyInstance): boolean {
  return fastify.config.SPLEX_PRO_ENABLED === true;
}

// The real guard. Throws ProUnavailableError (never returns false) so a
// caller cannot forget to check a boolean — every call site either gets
// past this line with a genuinely eligible user, or the request is
// already over. Call this FIRST, before any pro_* read or write.
export function assertProAccess(fastify: FastifyInstance, user: AuthedUser): void {
  if (!isProEnabled(fastify)) {
    throw new ProUnavailableError("disabled");
  }
  if (user.planTier !== "pro") {
    throw new ProUnavailableError("wrong_tier");
  }
}
