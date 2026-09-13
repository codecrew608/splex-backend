import { describe, it, expect } from "vitest";
import { isProEnabled, assertProAccess, ProUnavailableError } from "../src/pro/gate.js";
import type { AuthedUser } from "../src/types/index.js";

// SPLEX Pro launch is admin-operated (migration 0067's system_flags.
// pro_enabled), not a deploy-time config value — this file proves the
// backend enforcement item 31/32 requires — "the frontend must never
// control... without backend authorization" — actually holds, independent
// of anything the UI, or even an admin's own DB write, does wrong.

function fakeSupabaseAdmin(row: { enabled: boolean } | null, readError = false) {
  return {
    from(table: string) {
      if (table !== "system_flags") throw new Error(`fakeSupabaseAdmin: unexpected table "${table}"`);
      return {
        select() {
          return {
            eq(column: string, value: string) {
              if (column !== "key" || value !== "pro_enabled") {
                throw new Error(`fakeSupabaseAdmin: unexpected filter ${column}=${value}`);
              }
              return {
                maybeSingle: async () => (readError ? { data: null, error: { message: "boom" } } : { data: row, error: null }),
              };
            },
          };
        },
      };
    },
  };
}

function fastifyWith(enabled: boolean) {
  return { config: {}, supabaseAdmin: fakeSupabaseAdmin({ enabled }), log: { error: () => {} } } as never;
}

function user(overrides: Partial<AuthedUser> = {}): AuthedUser {
  return { id: "u1", email: "u1@example.com", planTier: "pro", orgId: null, timezone: "UTC", ...overrides };
}

describe("isProEnabled — reads the flag, nothing else", () => {
  it("false when the system_flags row says false", async () => {
    expect(await isProEnabled(fastifyWith(false))).toBe(false);
  });
  it("true only when the row is explicitly true", async () => {
    expect(await isProEnabled(fastifyWith(true))).toBe(true);
  });
  it("fails closed (false) when no row exists yet — never defaults to enabled on a missing seed", async () => {
    const fastify = { config: {}, supabaseAdmin: fakeSupabaseAdmin(null), log: { error: () => {} } } as never;
    expect(await isProEnabled(fastify)).toBe(false);
  });
  it("fails closed (false) on a DB read error — never lets a transient failure accidentally enable Pro", async () => {
    const fastify = { config: {}, supabaseAdmin: fakeSupabaseAdmin(null, true), log: { error: () => {} } } as never;
    expect(await isProEnabled(fastify)).toBe(false);
  });
});

describe("assertProAccess — the actual enforcement point", () => {
  it("throws ProUnavailableError('disabled') when the flag is off, REGARDLESS of the user's plan_tier", async () => {
    for (const planTier of ["free", "starter", "pro"] as const) {
      await expect(assertProAccess(fastifyWith(false), user({ planTier }))).rejects.toThrow(ProUnavailableError);
      try {
        await assertProAccess(fastifyWith(false), user({ planTier }));
      } catch (err) {
        expect(err).toBeInstanceOf(ProUnavailableError);
        expect((err as ProUnavailableError).reason).toBe("disabled");
      }
    }
  });

  it("with the flag ON, still refuses a non-pro user — reason 'wrong_tier'", async () => {
    for (const planTier of ["free", "starter"] as const) {
      try {
        await assertProAccess(fastifyWith(true), user({ planTier }));
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ProUnavailableError);
        expect((err as ProUnavailableError).reason).toBe("wrong_tier");
      }
    }
  });

  it("with the flag ON and planTier='pro', does NOT throw", async () => {
    await expect(assertProAccess(fastifyWith(true), user({ planTier: "pro" }))).resolves.not.toThrow();
  });

  it("the two failure messages never mention internals (provider names, table names, the flag's own name)", () => {
    const messages = [
      new ProUnavailableError("disabled").message,
      new ProUnavailableError("wrong_tier").message,
    ];
    for (const m of messages) {
      expect(m).not.toMatch(/system_flags|pro_enabled|pro_workflows|openai|anthropic|gemini|perplexity|xai/i);
    }
  });
});
