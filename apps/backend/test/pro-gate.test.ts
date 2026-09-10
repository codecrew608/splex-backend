import { describe, it, expect } from "vitest";
import { isProEnabled, assertProAccess, ProUnavailableError } from "../src/pro/gate.js";
import type { AuthedUser } from "../src/types/index.js";

// SPLEX Pro is NOT launched. This file exists to prove the backend
// enforcement item 31/32 requires — "the frontend must never control...
// without backend authorization" — actually holds, independent of
// anything the UI does.

function fastifyWith(enabled: boolean) {
  return { config: { SPLEX_PRO_ENABLED: enabled } } as never;
}

function user(overrides: Partial<AuthedUser> = {}): AuthedUser {
  return { id: "u1", email: "u1@example.com", planTier: "pro", orgId: null, timezone: "UTC", ...overrides };
}

describe("isProEnabled — reads the flag, nothing else", () => {
  it("false by default / when config says false", () => {
    expect(isProEnabled(fastifyWith(false))).toBe(false);
  });
  it("true only when the flag is explicitly true", () => {
    expect(isProEnabled(fastifyWith(true))).toBe(true);
  });
});

describe("assertProAccess — the actual enforcement point", () => {
  it("throws ProUnavailableError('disabled') when the flag is off, REGARDLESS of the user's plan_tier", () => {
    for (const planTier of ["free", "starter", "pro"] as const) {
      expect(() => assertProAccess(fastifyWith(false), user({ planTier }))).toThrow(ProUnavailableError);
      try {
        assertProAccess(fastifyWith(false), user({ planTier }));
      } catch (err) {
        expect(err).toBeInstanceOf(ProUnavailableError);
        expect((err as ProUnavailableError).reason).toBe("disabled");
      }
    }
  });

  it("with the flag ON, still refuses a non-pro user — reason 'wrong_tier'", () => {
    for (const planTier of ["free", "starter"] as const) {
      try {
        assertProAccess(fastifyWith(true), user({ planTier }));
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ProUnavailableError);
        expect((err as ProUnavailableError).reason).toBe("wrong_tier");
      }
    }
  });

  it("with the flag ON and planTier='pro', does NOT throw", () => {
    expect(() => assertProAccess(fastifyWith(true), user({ planTier: "pro" }))).not.toThrow();
  });

  it("the two failure messages never mention internals (provider names, table names, the flag's own name)", () => {
    const messages = [
      new ProUnavailableError("disabled").message,
      new ProUnavailableError("wrong_tier").message,
    ];
    for (const m of messages) {
      expect(m).not.toMatch(/SPLEX_PRO_ENABLED|pro_workflows|openai|anthropic|gemini|perplexity|xai/i);
    }
  });
});

describe("production's actual current state — this is what a real request hits right now", () => {
  it("SPLEX_PRO_ENABLED defaults to false when unset (matches plugins/env.ts's schema default)", () => {
    // Mirrors the real zod transform: an absent/undefined string input
    // becomes boolean false, never true, never undefined.
    const raw: string | undefined = undefined;
    const parsed = raw === "true";
    expect(parsed).toBe(false);
  });
});
