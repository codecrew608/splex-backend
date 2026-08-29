import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { consumeCredits } from "../src/credits/consumeCredits.js";
import { recordModelOutcome } from "../src/cortex/modelHealth.js";
import { withDeadline } from "../src/openrouter/client.js";

// Runtime counterparts to reliability.test.ts's source-level assertions:
// these actually execute the paths and inspect the resulting state, which
// is the only way to prove things like "a persistent RPC failure lands in
// credit_charge_failures with enough detail to reconcile from".

interface Recorded {
  table: string;
  rows: Record<string, unknown>[];
}

// A fastify fake whose credit RPCs can be made to fail deterministically,
// and which records what gets written to credit_charge_failures.
function makeFailingFastify(opts: { failRpcs: Set<string>; failInsert?: boolean }) {
  const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
  const inserts: Recorded[] = [];
  const logs: Array<{ level: string; msg: string; obj: Record<string, unknown> }> = [];
  const scheduled: Promise<unknown>[] = [];

  const fastify = {
    config: { CREDITS_PER_USD: 20000 },
    log: {
      error: (obj: Record<string, unknown>, msg?: string) => logs.push({ level: "error", msg: msg ?? "", obj }),
      warn: (obj: Record<string, unknown>, msg?: string) => logs.push({ level: "warn", msg: msg ?? "", obj }),
      info: () => {},
      debug: () => {},
    },
    supabaseAdmin: {
      rpc: async (name: string, params: Record<string, unknown> = {}) => {
        rpcCalls.push({ name, params });
        if (opts.failRpcs.has(name)) return { data: null, error: { message: `${name} exploded` } };
        return { data: null, error: null };
      },
      from: (table: string) => ({
        insert: (rows: Record<string, unknown> | Record<string, unknown>[]) => {
          const arr = Array.isArray(rows) ? rows : [rows];
          inserts.push({ table, rows: arr });
          return {
            then: (res: (v: { error: unknown }) => unknown) =>
              res({ error: opts.failInsert ? { message: "insert exploded" } : null }),
          };
        },
        select: function () { return this; },
        eq: function () { return this; },
        maybeSingle: async () => ({ data: null, error: null }),
        then: (res: (v: unknown) => unknown) => res({ data: null, error: null }),
      }),
    },
    scheduleBackground: (work: Promise<unknown>) => { scheduled.push(work); },
  } as never;

  return { fastify, rpcCalls, inserts, logs, scheduled };
}

describe("a persistent credit RPC failure is durably recorded, never silently dropped", () => {
  it("retries, then writes a reconcilable row to credit_charge_failures", async () => {
    const { fastify, rpcCalls, inserts } = makeFailingFastify({ failRpcs: new Set(["consume_credits"]) });

    await consumeCredits(fastify, {
      userId: "u1",
      creditCost: 660,
      intent: "workflow_step:writing",
      complexity: "complex",
      openrouterModelId: "test/model-1",
      realCostEstimate: 0.033,
      skipDaily: true,
    });

    // It genuinely retried rather than giving up on the first error.
    expect(rpcCalls.filter((c) => c.name === "consume_credits").length).toBeGreaterThan(1);

    const failures = inserts.filter((i) => i.table === "credit_charge_failures");
    expect(failures).toHaveLength(1);
    const row = failures[0].rows[0];
    // Every field a human (or a reconciliation script) needs to make this
    // right later: who, how much, which pool, why, and from what.
    expect(row.user_id).toBe("u1");
    expect(row.credit_cost).toBe(660);
    expect(row.pool).toBe("monthly");
    expect(row.rpc_name).toBe("consume_credits");
    expect(row.intent).toBe("workflow_step:writing");
    expect(row.error_message).toContain("exploded");
  });

  it("records the daily pool separately, so the two can never be conflated", async () => {
    const { fastify, inserts } = makeFailingFastify({ failRpcs: new Set(["consume_daily_credits"]) });

    await consumeCredits(fastify, {
      userId: "u1", creditCost: 25, intent: "chat", complexity: "simple",
      openrouterModelId: "m", realCostEstimate: 0.001,
      // skipDaily NOT set: this exercises the daily leg specifically.
    });

    const failures = inserts.filter((i) => i.table === "credit_charge_failures");
    expect(failures).toHaveLength(1);
    expect(failures[0].rows[0].pool).toBe("daily");
    expect(failures[0].rows[0].rpc_name).toBe("consume_daily_credits");
  });

  it("a successful charge writes NO failure row — failures can't accumulate phantom debt", async () => {
    const { fastify, inserts } = makeFailingFastify({ failRpcs: new Set() });
    await consumeCredits(fastify, {
      userId: "u1", creditCost: 10, intent: "chat", complexity: "simple",
      openrouterModelId: "m", realCostEstimate: 0.0005, skipDaily: true,
    });
    expect(inserts.filter((i) => i.table === "credit_charge_failures")).toHaveLength(0);
  });

  it("escalates loudly when even the failure record cannot be written", async () => {
    const { fastify, logs } = makeFailingFastify({ failRpcs: new Set(["consume_credits"]), failInsert: true });
    await consumeCredits(fastify, {
      userId: "u1", creditCost: 99, intent: "chat", complexity: "simple",
      openrouterModelId: "m", realCostEstimate: 0.005, skipDaily: true,
    });
    const critical = logs.find((l) => l.msg.includes("CRITICAL"));
    expect(critical).toBeDefined();
    // The log line is the only surviving trace, so it must carry the detail.
    expect(critical!.obj.userId).toBe("u1");
    expect(critical!.obj.creditCost).toBe(99);
  });

  it("never throws — a billing bookkeeping failure must not fail the user's request", async () => {
    const { fastify } = makeFailingFastify({ failRpcs: new Set(["consume_credits"]), failInsert: true });
    await expect(
      consumeCredits(fastify, {
        userId: "u1", creditCost: 1, intent: "chat", complexity: "simple",
        openrouterModelId: "m", realCostEstimate: 0, skipDaily: true,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("model-health background work is handed to the request's scheduler, not left floating", () => {
  it("registers with scheduleBackground when the runtime provides one (Workers)", async () => {
    const { fastify, scheduled } = makeFailingFastify({ failRpcs: new Set() });
    recordModelOutcome(fastify, "test/model-1", true, 120);
    // The whole point on Workers: the promise is handed to the request's
    // ExecutionContext rather than abandoned at isolate teardown.
    expect(scheduled).toHaveLength(1);
    await expect(Promise.all(scheduled)).resolves.toBeDefined();
  });

  it("a failing background write is swallowed and logged, never an unhandled rejection", async () => {
    const rejecting = {
      config: {},
      log: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
      supabaseAdmin: {
        rpc: async () => { throw new Error("network gone"); },
        from: () => ({
          insert: () => ({ then: (r: (v: unknown) => unknown) => r({ error: null }) }),
          select: function () { return this; },
          eq: function () { return this; },
          maybeSingle: async () => ({ data: null, error: null }),
          then: (r: (v: unknown) => unknown) => r({ data: null, error: null }),
        }),
      },
      scheduleBackground: undefined,
    } as never;

    // No scheduler (Node path): must still not produce an unhandled rejection.
    expect(() => recordModelOutcome(rejecting, "test/model-1", false, 0)).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe("deep research is bounded by BOTH its own budget and the caller going away", () => {
  const SRC = join(import.meta.dirname, "..", "src");
  const read = (p: string) => readFileSync(join(SRC, p), "utf8");

  it("combines the caller's signal into the run deadline rather than ignoring it", () => {
    const src = read("research/deepResearch.ts");
    // A bare AbortSignal.timeout() here (the previous state) meant closing
    // the tab did NOT stop the run: it kept issuing paid provider calls for
    // the rest of its 8-minute budget, charging for output nobody sees.
    expect(src).toContain("withDeadline(params.abortSignal, DEEP_RESEARCH_RUN_BUDGET_MS)");
    expect(src).not.toContain("AbortSignal.timeout(DEEP_RESEARCH_RUN_BUDGET_MS)");
  });

  it("chat.ts actually supplies that signal — the param existing is not enough", () => {
    const chat = read("handlers/chat.ts");
    const call = chat.slice(chat.indexOf("runDeepResearch({"), chat.indexOf("runDeepResearch({") + 400);
    expect(call).toContain("abortSignal: abortController.signal");
  });

  it("every stage receives the run deadline, so none can outlive the budget", () => {
    const src = read("research/deepResearch.ts");
    const stages = (src.match(/await runStage\(/g) ?? []).length;
    const signalled = (src.match(/signal: runDeadline/g) ?? []).length;
    expect(stages).toBeGreaterThan(0);
    expect(signalled).toBe(stages);
  });

  it("the per-stage cost lookup is itself bounded and fails safe", () => {
    const src = read("openrouter/client.ts");
    const fn = src.slice(src.indexOf("export async function fetchGenerationCost"));
    // A second network call per stage, outside completeOnce's deadline —
    // unbounded, it could hang a stage past both ceilings.
    expect(fn).toContain("AbortSignal.timeout(10_000)");
    expect(fn).toMatch(/catch[\s\S]{0,200}return 0;/);
  });
});

describe("withDeadline combines caller cancellation with a hard ceiling", () => {
  it("aborts immediately when the caller's signal is already aborted", () => {
    const ac = new AbortController();
    ac.abort();
    const combined = withDeadline(ac.signal, 60_000);
    expect(combined.aborted).toBe(true);
  });

  it("stays live while neither the caller nor the deadline has fired", () => {
    const ac = new AbortController();
    expect(withDeadline(ac.signal, 60_000).aborted).toBe(false);
  });

  it("still returns a working signal when no caller signal is supplied", () => {
    const s = withDeadline(undefined, 60_000);
    expect(s).toBeInstanceOf(AbortSignal);
    expect(s.aborted).toBe(false);
  });

  it("propagates a caller abort that happens later", async () => {
    const ac = new AbortController();
    const combined = withDeadline(ac.signal, 60_000);
    expect(combined.aborted).toBe(false);
    ac.abort();
    await new Promise((r) => setTimeout(r, 0));
    // This is what makes closing the tab actually stop deep research
    // rather than letting it spend for the rest of its 8-minute budget.
    expect(combined.aborted).toBe(true);
  });
});
