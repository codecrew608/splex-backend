import { describe, it, expect, vi } from "vitest";
import { resolveAuthedUser, extractBearerToken } from "../src/auth/resolveUser.js";

// resolveAuthedUser starts the users-table lookup speculatively, from the
// token's UNVERIFIED `sub` claim, in parallel with the authoritative
// auth.getUser() call. That is only safe if a forged `sub` can never
// decide who the caller is. These tests exist to prove exactly that — the
// performance win is worthless if it opens an impersonation path.

function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.signature-not-checked-here`;
}

interface Row {
  plan_tier: string;
  org_id: string | null;
  email: string;
}

function makeSupabase(opts: { verifiedUserId: string | null; rows: Record<string, Row> }) {
  const lookups: string[] = [];
  const supabase = {
    auth: {
      getUser: vi.fn(async () =>
        opts.verifiedUserId
          ? { data: { user: { id: opts.verifiedUserId } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
      ),
    },
    from: (_table: string) => ({
      select: function () { return this; },
      eq: function (_col: string, val: string) { lookups.push(val); (this as { _id?: string })._id = val; return this; },
      single: async function () {
        const id = (this as { _id?: string })._id as string;
        const row = opts.rows[id];
        return row ? { data: row, error: null } : { data: null, error: { message: "no row" } };
      },
    }),
  } as never;
  return { supabase, lookups };
}

describe("bearer token extraction", () => {
  it("accepts only a properly prefixed Bearer token", () => {
    expect(extractBearerToken("Bearer abc")).toBe("abc");
    expect(extractBearerToken("bearer abc")).toBeNull(); // case-sensitive by design
    expect(extractBearerToken("Basic abc")).toBeNull();
    expect(extractBearerToken("abc")).toBeNull();
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
  });
});

describe("the speculative lookup is a latency optimisation, never an authorization input", () => {
  it("resolves the verified user when the token's subject is genuine", async () => {
    const { supabase, lookups } = makeSupabase({
      verifiedUserId: "user-real",
      rows: { "user-real": { plan_tier: "pro", org_id: null, email: "real@example.com" } },
    });

    const result = await resolveAuthedUser(supabase, makeJwt({ sub: "user-real" }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.user).toEqual({ id: "user-real", email: "real@example.com", planTier: "pro", orgId: null });
    // Exactly one lookup: the speculative one was correct and got reused.
    expect(lookups).toEqual(["user-real"]);
  });

  it("a FORGED sub cannot impersonate: the verified id wins and is re-looked-up", async () => {
    // The attacker edits `sub` to a victim's id. The signature is invalid,
    // but this test pins the stronger property: even if verification were
    // to succeed as a DIFFERENT user, the forged claim is discarded.
    const { supabase, lookups } = makeSupabase({
      verifiedUserId: "user-attacker",
      rows: {
        "user-victim": { plan_tier: "pro", org_id: null, email: "victim@example.com" },
        "user-attacker": { plan_tier: "free", org_id: null, email: "attacker@example.com" },
      },
    });

    const result = await resolveAuthedUser(supabase, makeJwt({ sub: "user-victim" }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // Resolved as the ATTACKER (their real identity and their real free
    // tier) — never the victim, and never the victim's pro entitlement.
    expect(result.user.id).toBe("user-attacker");
    expect(result.user.email).toBe("attacker@example.com");
    expect(result.user.planTier).toBe("free");
    // The speculative victim lookup happened but was thrown away; a second,
    // authoritative lookup was issued for the verified id.
    expect(lookups).toEqual(["user-victim", "user-attacker"]);
  });

  it("rejects when the token fails verification, whatever it claims", async () => {
    const { supabase } = makeSupabase({
      verifiedUserId: null,
      rows: { "user-victim": { plan_tier: "pro", org_id: null, email: "victim@example.com" } },
    });
    const result = await resolveAuthedUser(supabase, makeJwt({ sub: "user-victim" }));
    expect(result.ok).toBe(false);
  });

  it("rejects a verified user with no users-table row (deleted account)", async () => {
    const { supabase } = makeSupabase({ verifiedUserId: "user-ghost", rows: {} });
    const result = await resolveAuthedUser(supabase, makeJwt({ sub: "user-ghost" }));
    expect(result.ok).toBe(false);
  });

  it("still authenticates correctly when the token is unparseable — it just loses the speedup", async () => {
    const { supabase, lookups } = makeSupabase({
      verifiedUserId: "user-real",
      rows: { "user-real": { plan_tier: "free", org_id: null, email: "real@example.com" } },
    });

    for (const malformed of ["", "not-a-jwt", "a.b", "a.!!!notbase64!!!.c", "a..c"]) {
      lookups.length = 0;
      const result = await resolveAuthedUser(supabase, malformed);
      expect(result.ok, `malformed token: ${malformed}`).toBe(true);
      // No speculative lookup fired; only the authoritative one.
      expect(lookups).toEqual(["user-real"]);
    }
  });

  it("a token with no sub claim falls back to the sequential path", async () => {
    const { supabase, lookups } = makeSupabase({
      verifiedUserId: "user-real",
      rows: { "user-real": { plan_tier: "free", org_id: null, email: "real@example.com" } },
    });
    const result = await resolveAuthedUser(supabase, makeJwt({ aud: "authenticated" }));
    expect(result.ok).toBe(true);
    expect(lookups).toEqual(["user-real"]);
  });

  it("plan tier always comes from the server row, never from a token claim", async () => {
    const { supabase } = makeSupabase({
      verifiedUserId: "user-real",
      rows: { "user-real": { plan_tier: "free", org_id: null, email: "real@example.com" } },
    });
    // Attacker stuffs a pro claim into their own (otherwise genuine) token.
    const result = await resolveAuthedUser(supabase, makeJwt({ sub: "user-real", plan_tier: "pro", role: "admin" }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.user.planTier).toBe("free");
  });

  it("the authoritative session check is still performed — revocation is not traded for speed", async () => {
    const { supabase } = makeSupabase({
      verifiedUserId: "user-real",
      rows: { "user-real": { plan_tier: "free", org_id: null, email: "real@example.com" } },
    });
    await resolveAuthedUser(supabase, makeJwt({ sub: "user-real" }));
    // Local-only JWT verification would have skipped this call, and with it
    // the server-side session state that makes sign-out effective.
    expect(supabase.auth.getUser).toHaveBeenCalledTimes(1);
  });
});
