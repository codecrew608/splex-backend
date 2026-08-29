import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlanTier } from "@splex/shared-types";
import type { AuthedUser } from "../types/index.js";

export type ResolveUserResult = { ok: true; user: AuthedUser } | { ok: false };

// Reads the `sub` claim WITHOUT verifying the signature.
//
// This value is treated as attacker-controlled and is used for exactly one
// thing: starting the users-table lookup early, in parallel with the real
// verification below. Its result is thrown away unless the verified id
// matches it. Nothing is ever authorized on the strength of this claim.
function peekUnverifiedSubject(token: string): string | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    // base64url -> base64, then decode. atob exists on both Workers and
    // Node >= 16, which is every runtime this ships to.
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const sub = (JSON.parse(json) as { sub?: unknown }).sub;
    return typeof sub === "string" && sub.length > 0 ? sub : null;
  } catch {
    // Malformed token — fall back to the strictly sequential path, which
    // is about to reject it anyway.
    return null;
  }
}

// Verifies a Supabase JWT and resolves the caller's plan tier.
//
// Shared by both entry points (plugins/auth.ts and worker/auth.ts) so the
// single most security-critical rule in this backend — "the client-sent
// user id is NEVER trusted; authorization comes from a verified token plus
// a server-side row" — is implemented once rather than duplicated.
//
// Two facts drive the shape of this function:
//
//   1. auth.getUser(token) is authoritative. It is a network call to
//      Supabase Auth that validates the signature AND the session's
//      server-side state, so a signed-out or revoked session is rejected
//      immediately. Verifying the JWT locally instead would remove that
//      revocation check and let a stolen-but-signed-out token keep working
//      until it expired — a real security regression in exchange for
//      latency, which is why this deliberately still makes the call. See
//      DEPLOYMENT.md for the full reasoning.
//   2. The users-table lookup cannot be skipped either: plan_tier is what
//      every paywall decision reads, and it must come from the server, not
//      from a claim the client could influence.
//
// Both calls are therefore required. What was NOT required is running them
// one after the other: the lookup only needs the user's id, which is
// already sitting (unverified) in the token. So the lookup is started
// speculatively, in parallel, and its result is used ONLY if the
// authoritative verification returns the same id. Worst case for a forged
// token is one wasted SELECT whose result is discarded; latency drops from
// t(getUser) + t(select) to max(t(getUser), t(select)) on every
// authenticated request.
export async function resolveAuthedUser(supabaseAdmin: SupabaseClient, token: string): Promise<ResolveUserResult> {
  const speculativeId = peekUnverifiedSubject(token);

  const lookup = (id: string) =>
    supabaseAdmin.from("users").select("plan_tier, org_id, email").eq("id", id).single();

  const [verified, speculativeRow] = await Promise.all([
    supabaseAdmin.auth.getUser(token),
    speculativeId ? lookup(speculativeId) : Promise.resolve(null),
  ]);

  if (verified.error || !verified.data.user) return { ok: false };
  const userId = verified.data.user.id;

  // Use the speculative row ONLY when the token's claimed subject turned
  // out to be the verified one. Any mismatch (a forged/edited `sub`) falls
  // through to a fresh, correct lookup — the speculative result is never
  // allowed to decide who the caller is.
  const rowResult = speculativeId === userId && speculativeRow ? speculativeRow : await lookup(userId);

  if (rowResult.error || !rowResult.data) return { ok: false };
  const userRow = rowResult.data;

  return {
    ok: true,
    user: {
      id: userId,
      email: userRow.email as string,
      planTier: userRow.plan_tier as PlanTier,
      orgId: (userRow.org_id as string | null) ?? null,
    },
  };
}

export function extractBearerToken(header: string | null | undefined): string | null {
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
}
