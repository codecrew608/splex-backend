import { vi } from "vitest";

// An in-memory stand-in for the parts of FastifyInstance the credit and
// routing code actually touches: supabaseAdmin (rpc / from / storage / auth),
// log, and config.
//
// Deliberately a hand-rolled fake rather than a mocking library: these tests
// are about ARITHMETIC and ORDERING (how many times the daily counter is
// moved, in what direction, under concurrency), and a fake that models the
// counter as real mutable state catches a double-charge that assertion-on-
// call-count alone would miss. The 2x daily overcharge that shipped would
// have been caught by this file's `dailyUsed` bookkeeping, not by a spy.

export interface FakeState {
  planTier: "free" | "pro";
  dailyLimit: number | null;
  monthlyLimit: number | null;
  dailyUsed: number;
  monthlyUsed: number;
  // media rows keyed by id
  media: Map<string, { user_id: string; credits_reserved: number; reservation_period: string | null; status: string }>;
  // Agent-Workflow tables (migration 0007). Loosely typed (Record, not the
  // orchestrator's own WorkflowRunRow) so this file doesn't have to import
  // from src/ — same idiom as `media` above.
  workflowRuns: Map<string, Record<string, unknown>>;
  workflowSteps: Map<string, Record<string, unknown>>; // keyed "${runId}:${stepIndex}"
  messages: Map<string, Record<string, unknown>>;
  nextId: number;
  rpcCalls: Array<{ name: string; params: Record<string, unknown> }>;
  logs: Array<{ level: string; msg: string }>;
}

export function makeState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    planTier: "free",
    dailyLimit: 150,
    monthlyLimit: 3000,
    dailyUsed: 0,
    monthlyUsed: 0,
    media: new Map(),
    workflowRuns: new Map(),
    workflowSteps: new Map(),
    messages: new Map(),
    nextId: 1,
    rpcCalls: [],
    logs: [],
    ...overrides,
  };
}

const PERIOD = "2026-08-28";

// Faithful re-implementations of the production RPCs' semantics, taken from
// their pg_get_functiondef output — including the details that matter:
// reserve is a conditional increment that CANNOT exceed the cap, settle is
// idempotent and guards against driving a counter negative, and a missing
// plan_limits row fails CLOSED rather than being treated as unlimited.
function rpcImpl(state: FakeState, name: string, p: Record<string, unknown>): unknown {
  switch (name) {
    case "check_credits": {
      if (state.monthlyLimit === null) return false; // fail closed
      return state.monthlyUsed + Number(p.p_credit_cost) <= state.monthlyLimit;
    }
    case "check_daily_credits": {
      if (state.dailyLimit === null) return false; // fail closed
      return state.dailyUsed + Number(p.p_credit_cost) <= state.dailyLimit;
    }
    case "reserve_daily_credits": {
      const amount = Number(p.p_reserve_amount);
      if (state.dailyLimit === null) return false;
      if (amount > state.dailyLimit) return false;
      if (state.dailyUsed + amount > state.dailyLimit) return false;
      state.dailyUsed += amount;
      return true;
    }
    case "consume_daily_credits": {
      state.dailyUsed += Number(p.p_credit_cost);
      return null;
    }
    case "consume_credits": {
      state.monthlyUsed += Number(p.p_credit_cost);
      return null;
    }
    case "reserve_media_credits": {
      const amount = Number(p.p_reserve_amount);
      const row = state.media.get(String(p.p_media_id));
      if (!row) return false;
      if (state.dailyLimit === null) return false;
      if (amount > state.dailyLimit) return false;
      if (state.dailyUsed + amount > state.dailyLimit) return false;
      state.dailyUsed += amount;
      row.credits_reserved = amount;
      row.reservation_period = PERIOD;
      return true;
    }
    case "settle_media_reservation": {
      const row = state.media.get(String(p.p_media_id));
      if (!row || row.credits_reserved === 0) return false; // idempotent no-op
      const delta = Number(p.p_actual_cost) - row.credits_reserved;
      if (delta !== 0 && row.reservation_period) {
        state.dailyUsed = Math.max(0, state.dailyUsed + delta);
      }
      row.credits_reserved = 0;
      return true;
    }
    case "release_stale_media_reservations":
      return 0;
    case "diagnose_credit_rejection":
      return { reason: "daily_exhausted" };
    default:
      return null;
  }
}

type Predicate = { kind: "eq" | "lt" | "lte" | "gte"; col: string; val: unknown } | { kind: "in"; col: string; vals: unknown[] };

function matches(row: Record<string, unknown>, predicates: Predicate[]): boolean {
  return predicates.every((p) => {
    const cell = row[p.col];
    if (p.kind === "eq") return cell === p.val;
    if (p.kind === "gte") return (cell as string) >= (p.val as string);
    if (p.kind === "lt") return (cell as number) < (p.val as number);
    if (p.kind === "lte") return (cell as number) <= (p.val as number);
    return (p.vals as unknown[]).includes(cell);
  });
}

// Table-specific defaults, matching db/migrations/0007_workflow_orchestration.sql
// (workflow_runs/workflow_steps) and the messages table's own schema —
// only the columns the orchestrator/persistence layer actually reads or
// writes, not a full schema mirror.
const ROW_DEFAULTS: Record<string, Record<string, unknown>> = {
  workflow_runs: {
    status: "planning",
    plan: null,
    clarification_question: null,
    clarification_step_index: null,
    current_step_index: 0,
  },
  workflow_steps: {
    status: "pending",
    output: null,
    routed_model: null,
    credits_charged: null,
    real_input_tokens: null,
    real_output_tokens: null,
  },
  messages: {
    intent: null,
    complexity: null,
    credits_charged: null,
    routed_model: null,
  },
};

// A real (if minimal) query builder for the three tables the workflow
// orchestrator round-trips through the SAME request as credit RPCs
// (workflow_runs, workflow_steps, messages) — everything else keeps going
// through the older fully-generic, always-null stub below, unchanged.
//
// Modeled closely enough on supabase-js's own builder shape to matter for
// correctness, not just API compatibility: every chain method mutates and
// returns THIS SAME object (so `await` can land after any link in the
// chain, exactly like the real thing), and — this is the part that's
// actually load-bearing, not cosmetic — the match-then-mutate for
// `update()` happens synchronously inside `then()`, with no `await`
// anywhere in between. That's what makes the "atomic claim" pattern in
// resumeWorkflow (UPDATE ... WHERE status = 'awaiting_clarification')
// genuinely atomic in this fake, the same way a single real SQL statement
// is atomic against concurrent requests. If a future edit here ever
// inserts an await between the predicate check and the mutation, tests
// that rely on that atomicity (see workflow.test.ts's race scenario) could
// pass by accident (Node/Vitest has no real parallelism to expose it) while
// no longer proving what they claim to.
function makeWorkflowBuilder(table: "workflow_runs" | "workflow_steps" | "messages", state: FakeState) {
  const store = table === "workflow_runs" ? state.workflowRuns : table === "workflow_steps" ? state.workflowSteps : state.messages;
  const predicates: Predicate[] = [];
  let op: "select" | "insert" | "update" | null = null;
  let payload: Record<string, unknown> | Record<string, unknown>[] | null = null;
  let orderCol: string | null = null;
  let orderAsc = true;
  let limitN: number | null = null;
  let singleMode: "single" | "maybeSingle" | null = null;

  const api: Record<string, unknown> = {};

  function keyFor(row: Record<string, unknown>): string {
    if (table === "workflow_steps") return `${row.workflow_run_id}:${row.step_index}`;
    return row.id as string;
  }

  function allRows(): Array<[string, Record<string, unknown>]> {
    return Array.from(store.entries());
  }

  function selected(): Record<string, unknown>[] {
    let rows = allRows()
      .filter(([, row]) => matches(row, predicates))
      .map(([, row]) => row);
    if (orderCol) {
      const col = orderCol;
      rows = [...rows].sort((a, b) => {
        const av = String(a[col]);
        const bv = String(b[col]);
        return orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    if (limitN !== null) rows = rows.slice(0, limitN);
    return rows;
  }

  Object.assign(api, {
    select: () => api,
    insert: (vals: Record<string, unknown> | Record<string, unknown>[]) => {
      op = "insert";
      payload = vals;
      return api;
    },
    update: (vals: Record<string, unknown>) => {
      op = "update";
      payload = vals;
      return api;
    },
    eq: (col: string, val: unknown) => {
      predicates.push({ kind: "eq", col, val });
      return api;
    },
    in: (col: string, vals: unknown[]) => {
      predicates.push({ kind: "in", col, vals });
      return api;
    },
    lt: (col: string, val: unknown) => {
      predicates.push({ kind: "lt", col, val });
      return api;
    },
    lte: (col: string, val: unknown) => {
      predicates.push({ kind: "lte", col, val });
      return api;
    },
    gte: (col: string, val: unknown) => {
      predicates.push({ kind: "gte", col, val });
      return api;
    },
    order: (col: string, opts?: { ascending?: boolean }) => {
      orderCol = col;
      orderAsc = opts?.ascending !== false;
      return api;
    },
    limit: (n: number) => {
      limitN = n;
      return api;
    },
    single: () => {
      singleMode = "single";
      return api;
    },
    maybeSingle: () => {
      singleMode = "maybeSingle";
      return api;
    },
    // Every other terminal (single/maybeSingle) already returns `api`
    // itself above, so the ACTUAL execution has to happen here, in then() —
    // whichever chain link is awaited last is what triggers it. This is
    // also, deliberately, the ONLY place a mutation is applied: no chain
    // method above touches `store` directly.
    then: (resolve: (v: { data: unknown; error: unknown }) => unknown) => {
      if (op === "insert") {
        const rows = (Array.isArray(payload) ? payload : [payload]) as Record<string, unknown>[];
        const inserted = rows.map((p) => {
          const id = `${table}-${state.nextId++}`;
          const row: Record<string, unknown> = { ...ROW_DEFAULTS[table], ...p, id };
          store.set(keyFor(row), row);
          return row;
        });
        if (singleMode) return resolve({ data: inserted[0] ?? null, error: null });
        return resolve({ data: null, error: null }); // bulk insert: callers here never read the result
      }

      if (op === "update") {
        // Synchronous check-then-mutate — see the function doc comment
        // above for why that ordering is the actual point.
        const targets = allRows().filter(([, row]) => matches(row, predicates));
        for (const [, row] of targets) Object.assign(row, payload);
        if (singleMode) {
          const first = targets[0]?.[1] ?? null;
          return resolve({ data: first, error: null });
        }
        return resolve({ data: null, error: null });
      }

      // select (or op === null, e.g. a bare .from(table) never chained
      // into insert/update — treat as select-all, matching supabase-js)
      const rows = selected();
      if (singleMode === "single" || singleMode === "maybeSingle") {
        return resolve({ data: rows[0] ?? null, error: null });
      }
      return resolve({ data: rows, error: null });
    },
  });

  return api;
}

export function makeFastify(state: FakeState) {
  const log = {
    error: (o: unknown, m?: string) => state.logs.push({ level: "error", msg: m ?? String(o) }),
    warn: (o: unknown, m?: string) => state.logs.push({ level: "warn", msg: m ?? String(o) }),
    info: () => {},
    debug: () => {},
  };

  const supabaseAdmin = {
    rpc: vi.fn(async (name: string, params: Record<string, unknown> = {}) => {
      state.rpcCalls.push({ name, params });
      return { data: rpcImpl(state, name, params), error: null };
    }),
    from: (table: string) => {
      if (table === "workflow_runs" || table === "workflow_steps" || table === "messages") {
        return makeWorkflowBuilder(table, state);
      }

      // Original fully-generic stub, unchanged, for every other table
      // (generated_media, plan_limits, credit_cost_bands, model_registry,
      // user_memory, cortex_decisions, ...): always resolves null/[],
      // which is exactly the conservative-fallback behavior those code
      // paths are already written (and tested) to degrade into.
      const api: Record<string, unknown> = {};
      const chain = () => api;
      Object.assign(api, {
        select: chain, eq: chain, in: chain, gte: chain, order: chain, limit: chain,
        update: (vals: Record<string, unknown>) => {
          if (table === "generated_media") {
            api.__pendingUpdate = vals;
          }
          return api;
        },
        insert: chain,
        upsert: chain,
        single: async () => ({ data: null, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        then: (res: (v: unknown) => unknown) => res({ data: null, error: null }),
      });
      return api;
    },
  };

  return { supabaseAdmin, log, config: { CORTEX_CLASSIFIER_MODEL_ID: "stub", CREDITS_PER_USD: 20000 } } as never;
}

export function makeMedia(state: FakeState, userId = "u1"): string {
  const id = `media-${state.media.size + 1}`;
  state.media.set(id, { user_id: userId, credits_reserved: 0, reservation_period: null, status: "queued" });
  return id;
}

// Seed helpers for the workflow tables, same idiom as makeMedia above.
export function makeWorkflowRun(state: FakeState, overrides: Record<string, unknown> = {}): string {
  const id = `run-${state.nextId++}`;
  const now = new Date().toISOString();
  state.workflowRuns.set(id, {
    ...ROW_DEFAULTS.workflow_runs,
    id,
    conversation_id: "conv-1",
    user_message_id: "msg-1",
    created_at: now,
    updated_at: now,
    ...overrides,
  });
  return id;
}

export function makeWorkflowStep(
  state: FakeState,
  runId: string,
  stepIndex: number,
  overrides: Record<string, unknown> = {},
): void {
  const id = `step-${state.nextId++}`;
  state.workflowSteps.set(`${runId}:${stepIndex}`, {
    ...ROW_DEFAULTS.workflow_steps,
    id,
    workflow_run_id: runId,
    step_index: stepIndex,
    title: `Step ${stepIndex}`,
    category: "writing",
    category_label: "Writing",
    detailed_prompt: `Do step ${stepIndex}`,
    ...overrides,
  });
}
