import { describe, it, expect } from "vitest";
import { getProStatus, handleCreateProWorkflow } from "../src/handlers/pro.js";
import type { AuthedUser } from "../src/types/index.js";

function user(overrides: Partial<AuthedUser> = {}): AuthedUser {
  return { id: "u1", email: "u1@example.com", planTier: "pro", orgId: null, timezone: "UTC", ...overrides };
}

// Same minimal stub as pro-orchestrator.test.ts — only the tables
// createProWorkflow's persistence path actually touches.
function makeProDbStub() {
  let nextId = 1;
  const id = () => `id-${nextId++}`;
  return {
    from(table: string) {
      if (table === "pro_workflows") {
        return {
          insert: () => ({ select: () => ({ single: async () => ({ data: { id: id() }, error: null }) }) }),
          update: () => ({ eq: async () => ({ data: null, error: null }) }),
        };
      }
      if (table === "pro_tasks") {
        return { insert: () => ({ select: () => ({ single: async () => ({ data: { id: id() }, error: null }) }) }) };
      }
      if (table === "pro_task_dependencies") {
        return { insert: async () => ({ data: null, error: null }) };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

function fastifyWith(enabled: boolean) {
  return { config: { SPLEX_PRO_ENABLED: enabled }, supabaseAdmin: makeProDbStub() } as never;
}

describe("GET /pro/status — getProStatus", () => {
  it("never requires auth and always returns 200, flag off (production's real state today)", () => {
    const result = getProStatus(fastifyWith(false));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        enabled: false,
        status: "coming_soon",
        priceInrPerMonth: 799,
        monthlyCredits: 150000,
        engineName: "Cortex 2",
      });
    }
  });

  it("reflects the flag honestly when on — never hardcoded false", () => {
    const result = getProStatus(fastifyWith(true));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body?.enabled).toBe(true);
      expect(result.body?.status).toBe("available");
    }
  });

  it("carries no field beyond price/credits/enabled/status/engineName — no real provider names, no internal ids", () => {
    const result = getProStatus(fastifyWith(true));
    if (result.ok) {
      expect(Object.keys(result.body ?? {}).sort()).toEqual([
        "enabled",
        "engineName",
        "monthlyCredits",
        "priceInrPerMonth",
        "status",
      ]);
      expect(result.body?.engineName).toBe("Cortex 2");
    }
  });
});

describe("POST /pro/workflows — handleCreateProWorkflow, the real enforcement boundary", () => {
  it("flag off -> 403 for a pro-tier user with a perfectly valid body (the UI is NEVER the gate)", async () => {
    const result = await handleCreateProWorkflow(fastifyWith(false), user({ planTier: "pro" }), { objective: "Build something." });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("flag off -> 403 regardless of plan_tier (free/starter/pro all refused identically)", async () => {
    for (const planTier of ["free", "starter", "pro"] as const) {
      const result = await handleCreateProWorkflow(fastifyWith(false), user({ planTier }), { objective: "Build something." });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(403);
    }
  });

  it("flag on but wrong tier -> 403, never a 500 or a silent pass-through", async () => {
    const result = await handleCreateProWorkflow(fastifyWith(true), user({ planTier: "starter" }), { objective: "Build something." });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("gate runs BEFORE body validation — an invalid body with the flag off still reports 403, not 400", async () => {
    const result = await handleCreateProWorkflow(fastifyWith(false), user({ planTier: "pro" }), { objective: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("flag on, correct tier, empty objective -> 400", async () => {
    const result = await handleCreateProWorkflow(fastifyWith(true), user({ planTier: "pro" }), { objective: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it("flag on, correct tier, missing objective field entirely -> 400, not a crash", async () => {
    const result = await handleCreateProWorkflow(fastifyWith(true), user({ planTier: "pro" }), {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it("flag on, correct tier, non-string objective -> 400 (a client sending {objective: 42} doesn't crash the handler)", async () => {
    const result = await handleCreateProWorkflow(fastifyWith(true), user({ planTier: "pro" }), { objective: 42 as unknown });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it("flag on, correct tier, oversized objective (>4000 chars) -> 400", async () => {
    const result = await handleCreateProWorkflow(fastifyWith(true), user({ planTier: "pro" }), { objective: "x".repeat(4001) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it("flag on, correct tier, whitespace-only objective -> 400 (trimmed before the length check)", async () => {
    const result = await handleCreateProWorkflow(fastifyWith(true), user({ planTier: "pro" }), { objective: "   " });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it("flag on, correct tier, valid objective -> 201 with the orchestrator's real result", async () => {
    const result = await handleCreateProWorkflow(fastifyWith(true), user({ planTier: "pro" }), {
      objective: "Research, design, implement and verify a full system.",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe(201);
      expect(result.body?.complexity).toBe("collaborative");
      expect(result.body?.workflowId).toBeDefined();
    }
  });

  it("flag on, correct tier, simple objective -> 201 with complexity:'simple' and no workflowId", async () => {
    const result = await handleCreateProWorkflow(fastifyWith(true), user({ planTier: "pro" }), { objective: "What is 7 * 8?" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body?.complexity).toBe("simple");
      expect(result.body?.workflowId).toBeUndefined();
    }
  });
});
