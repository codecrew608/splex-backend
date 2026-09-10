import { randomUUID } from "node:crypto";

// In-process fake of the pro_* tables + the credit RPCs execution.ts
// touches, purpose-built for test/pro-concurrency.test.ts.
//
// WHY a bespoke fake and not fakeFastify.ts: fakeFastify.ts's query builder
// predates every pro_* table and models none of them, and the ordinary
// chat path it DOES model has no overlap with the Pro execution engine.
// Building the Pro surface into that shared fake would be a large change to
// a file a lot of unrelated tests depend on, for one feature with zero
// live callers. Kept here, next to its only consumer.
//
// The one fidelity property this fake MUST preserve to be worth running:
// the terminal of a chained query (single/maybeSingle/await) does its
// filter-match-and-mutate SYNCHRONOUSLY, with no `await` between reading
// the matching rows and writing them. That is what makes a conditional
// UPDATE (`.update({status}).eq("id",x).eq("status","WAITING_FOR_TASKS")`)
// behave like Postgres's own atomic row UPDATE under `Promise.all` — the
// microtask queue serialises the two terminals, exactly one sees the
// pre-transition status, and the loser's re-read sees the winner's write.
// Every mutation below is a plain synchronous array/Map operation for that
// reason; only the returned Promise is async.

export type Row = Record<string, unknown>;

export interface ProFakeState {
  workflows: Map<string, Row>;
  tasks: Map<string, Row>;
  deps: Row[];
  providerRuns: Map<string, Row>;
  artifacts: Map<string, Row>;
  collabMessages: Row[];
  verificationResults: Row[];
  budgetReservations: Row[];
  users: Map<string, Row>;
  userMemories: Row[];
  projectMemories: Row[];
  legacyUserMemory: Map<string, string>;
  monthlyUsed: Map<string, number>;
  monthlyLimit: number;
  dailyUsed: Map<string, number>;
  dailyLimit: number;
  creditLedger: Row[];
  rpcCalls: string[];
}

function emptyState(): ProFakeState {
  return {
    workflows: new Map(),
    tasks: new Map(),
    deps: [],
    providerRuns: new Map(),
    artifacts: new Map(),
    collabMessages: [],
    verificationResults: [],
    budgetReservations: [],
    users: new Map(),
    userMemories: [],
    projectMemories: [],
    legacyUserMemory: new Map(),
    monthlyUsed: new Map(),
    monthlyLimit: 150_000,
    dailyUsed: new Map(),
    dailyLimit: 5_000,
    creditLedger: [],
    rpcCalls: [],
  };
}

interface Filter {
  kind: "eq" | "in" | "not_in";
  col: string;
  val: unknown;
}

function rowMatches(row: Row, filters: Filter[]): boolean {
  for (const f of filters) {
    if (f.kind === "eq" && row[f.col] !== f.val) return false;
    if (f.kind === "in" && !(f.val as unknown[]).includes(row[f.col])) return false;
    if (f.kind === "not_in" && (f.val as unknown[]).includes(row[f.col])) return false;
  }
  return true;
}

// Every table's rows as a flat array, plus how to add/replace one.
function tableRows(state: ProFakeState, table: string): Row[] {
  switch (table) {
    case "pro_workflows": return [...state.workflows.values()];
    case "pro_tasks": return [...state.tasks.values()];
    case "pro_task_dependencies": return state.deps;
    case "pro_provider_runs": return [...state.providerRuns.values()];
    case "pro_artifacts": return [...state.artifacts.values()];
    case "pro_collaboration_messages": return state.collabMessages;
    case "pro_verification_results": return state.verificationResults;
    case "pro_budget_reservations": return state.budgetReservations;
    case "users": return [...state.users.values()];
    case "user_memories": return state.userMemories;
    case "user_memory":
      return [...state.legacyUserMemory.entries()].map(([user_id, summary_text]) => ({ user_id, summary_text }));
    case "project_memories": return state.projectMemories;
    default: throw new Error(`proFakeDb: unmodeled table "${table}"`);
  }
}

const KEYED = new Set(["pro_workflows", "pro_tasks", "pro_provider_runs", "pro_artifacts"]);

// Column defaults migration 0061 gives these tables — applied on insert so
// a row written the way execution.ts writes it (relying on the DB default)
// matches what a real insert would produce.
const INSERT_DEFAULTS: Record<string, Row> = {
  pro_budget_reservations: { status: "reserved", settled_credits: null, settled_at: null },
  pro_provider_runs: { status: "running" },
  pro_artifacts: { status: "final", verification_state: "unreviewed", parent_artifact_ids: [] },
};

function keyedMap(state: ProFakeState, table: string): Map<string, Row> {
  switch (table) {
    case "pro_workflows": return state.workflows;
    case "pro_tasks": return state.tasks;
    case "pro_provider_runs": return state.providerRuns;
    case "pro_artifacts": return state.artifacts;
    default: throw new Error(table);
  }
}

class Query implements PromiseLike<{ data: unknown; error: unknown }> {
  private op: "select" | "insert" | "update" | "delete" = "select";
  private filters: Filter[] = [];
  private payload: unknown = null;
  private wantSingle: false | "single" | "maybe" = false;

  constructor(private state: ProFakeState, private table: string) {}

  select(_cols?: string) { if (this.op !== "insert" && this.op !== "update" && this.op !== "delete") this.op = "select"; return this; }
  insert(rows: Row | Row[]) { this.op = "insert"; this.payload = rows; return this; }
  update(patch: Row) { this.op = "update"; this.payload = patch; return this; }
  delete() { this.op = "delete"; return this; }
  upsert(rows: Row | Row[]) { this.op = "insert"; this.payload = rows; return this; }

  eq(col: string, val: unknown) { this.filters.push({ kind: "eq", col, val }); return this; }
  in(col: string, val: unknown[]) { this.filters.push({ kind: "in", col, val }); return this; }
  not(col: string, operator: string, val: unknown) {
    if (operator !== "in") throw new Error(`proFakeDb: unsupported .not(${operator})`);
    // supabase-js encodes .not("x","in","(a,b,c)") as a literal string.
    const parsed = typeof val === "string" ? val.replace(/^\(|\)$/g, "").split(",") : (val as unknown[]);
    this.filters.push({ kind: "not_in", col, val: parsed });
    return this;
  }
  order(_col: string, _opts?: unknown) { return this; }
  limit(_n: number) { return this; }

  single() { this.wantSingle = "single"; return this.run(); }
  maybeSingle() { this.wantSingle = "maybe"; return this.run(); }
  then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.run().then(onfulfilled, onrejected);
  }

  // Synchronous body — see file header. The `async` keyword only wraps the
  // already-computed result in a Promise; nothing below yields.
  private run(): Promise<{ data: unknown; error: unknown }> {
    try {
      const result = this.execute();
      return Promise.resolve({ data: result, error: null });
    } catch (err) {
      return Promise.resolve({ data: null, error: { message: String(err) } });
    }
  }

  private shape(rows: Row[]): unknown {
    if (this.wantSingle === "single") {
      if (rows.length !== 1) throw new Error(`.single() expected 1 row, got ${rows.length} on ${this.table}`);
      return rows[0];
    }
    if (this.wantSingle === "maybe") return rows[0] ?? null;
    return rows;
  }

  private execute(): unknown {
    const state = this.state;

    if (this.op === "insert") {
      const incoming = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      const inserted: Row[] = [];
      for (const raw of incoming) {
        const row: Row = { ...(INSERT_DEFAULTS[this.table] ?? {}), ...raw };
        if (KEYED.has(this.table)) {
          if (!row.id) row.id = randomUUID();
          keyedMap(state, this.table).set(row.id as string, row);
        } else if (this.table === "user_memory") {
          state.legacyUserMemory.set(row.user_id as string, row.summary_text as string);
        } else {
          tableRows(state, this.table).push(row);
        }
        if (row.created_at === undefined) row.created_at = new Date().toISOString();
        inserted.push(row);
      }
      return this.shape(inserted);
    }

    const matching = tableRows(state, this.table).filter((r) => rowMatches(r, this.filters));

    if (this.op === "update") {
      for (const row of matching) Object.assign(row, this.payload as Row);
      return this.shape(matching);
    }
    if (this.op === "delete") {
      const arr = tableRows(state, this.table);
      for (const row of matching) {
        const i = arr.indexOf(row);
        if (i >= 0) arr.splice(i, 1);
        if (KEYED.has(this.table)) keyedMap(state, this.table).delete(row.id as string);
      }
      return this.shape(matching);
    }
    // select
    return this.shape(matching.map((r) => ({ ...r })));
  }
}

export interface ProFakeDb {
  supabaseAdmin: {
    from(table: string): Query;
    rpc(name: string, params: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
  };
  state: ProFakeState;
}

export function makeProFakeDb(seed?: Partial<ProFakeState>): ProFakeDb {
  const state = { ...emptyState(), ...seed };

  const supabaseAdmin = {
    from(table: string) {
      return new Query(state, table);
    },
    // Deterministic stand-ins for the four credit RPCs. Synchronous bodies,
    // same reason as Query.run. These model the REAL semantics that matter
    // for the credit-integrity assertions:
    //  - check_credits: monthly pool read-only gate (used + cost <= limit)
    //  - reserve_daily_credits: atomic check+increment, hard-reject amount>limit
    //  - consume_credits: monthly pool increment + ledger row (never gates)
    //  - consume_daily_credits: daily pool signed delta
    rpc(name: string, params: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> {
      state.rpcCalls.push(name);
      const uid = params.p_user_id as string;
      if (name === "check_credits") {
        const used = state.monthlyUsed.get(uid) ?? 0;
        return Promise.resolve({ data: used + (params.p_credit_cost as number) <= state.monthlyLimit, error: null });
      }
      if (name === "check_daily_credits") {
        const used = state.dailyUsed.get(uid) ?? 0;
        return Promise.resolve({ data: used + (params.p_credit_cost as number) <= state.dailyLimit, error: null });
      }
      if (name === "reserve_daily_credits") {
        const amount = params.p_reserve_amount as number;
        if (amount > state.dailyLimit) return Promise.resolve({ data: false, error: null });
        const used = state.dailyUsed.get(uid) ?? 0;
        if (used + amount > state.dailyLimit) return Promise.resolve({ data: false, error: null });
        state.dailyUsed.set(uid, used + amount);
        return Promise.resolve({ data: true, error: null });
      }
      if (name === "consume_credits") {
        const cost = params.p_credit_cost as number;
        state.monthlyUsed.set(uid, (state.monthlyUsed.get(uid) ?? 0) + cost);
        state.creditLedger.push({
          user_id: uid,
          credit_cost: cost,
          intent: params.p_intent,
          openrouter_model_id: params.p_openrouter_model_id,
        });
        return Promise.resolve({ data: null, error: null });
      }
      if (name === "consume_daily_credits") {
        const delta = params.p_credit_cost as number;
        state.dailyUsed.set(uid, Math.max(0, (state.dailyUsed.get(uid) ?? 0) + delta));
        return Promise.resolve({ data: null, error: null });
      }
      return Promise.resolve({ data: null, error: { message: `proFakeDb: unmodeled rpc "${name}"` } });
    },
  };

  return { supabaseAdmin, state };
}

// A pre-planned workflow, written straight into fake state the way
// orchestrator.ts's createProWorkflow would leave it: status
// WAITING_FOR_TASKS, every task PENDING, edges in place.
export function seedWorkflow(
  db: ProFakeDb,
  opts: {
    userId: string;
    objective?: string;
    projectId?: string | null;
    phases: Array<{ phase: string; operation: string; requiredCapabilities?: string[]; dependsOn?: string[]; assignedProvider?: string | null }>;
    budget?: Partial<{
      max_provider_calls: number;
      max_token_budget: number;
      max_estimated_cost_credits: number;
      max_execution_ms: number;
      max_retry_count: number;
      max_collaboration_depth: number;
      max_parallel_branches: number;
    }>;
  },
): { workflowId: string; taskIdByPhase: Map<string, string> } {
  const workflowId = randomUUID();
  db.state.workflows.set(workflowId, {
    id: workflowId,
    user_id: opts.userId,
    project_id: opts.projectId ?? null,
    objective: opts.objective ?? "Research, architect, implement, review and verify a small service.",
    status: "WAITING_FOR_TASKS",
    max_provider_calls: opts.budget?.max_provider_calls ?? 20,
    max_token_budget: opts.budget?.max_token_budget ?? 200_000,
    max_estimated_cost_credits: opts.budget?.max_estimated_cost_credits ?? 25_000,
    max_execution_ms: opts.budget?.max_execution_ms ?? 600_000,
    max_retry_count: opts.budget?.max_retry_count ?? 3,
    max_collaboration_depth: opts.budget?.max_collaboration_depth ?? 4,
    max_parallel_branches: opts.budget?.max_parallel_branches ?? 5,
    reserved_credits: 0,
    actual_cost_credits: null,
    plan: { phases: opts.phases.map((p) => p.phase) },
    clarification_question: null,
    clarification_task_id: null,
    created_at: new Date().toISOString(),
  });

  const taskIdByPhase = new Map<string, string>();
  for (const spec of opts.phases) {
    const taskId = randomUUID();
    taskIdByPhase.set(spec.phase, taskId);
    db.state.tasks.set(taskId, {
      id: taskId,
      workflow_id: workflowId,
      objective: `[${spec.phase}] ${spec.operation}`,
      operation: spec.operation,
      status: "PENDING",
      retry_count: 0,
      assigned_provider: spec.assignedProvider ?? null,
      assigned_model: null,
      required_capabilities: spec.requiredCapabilities ?? [],
      estimated_cost_credits: null,
      actual_cost_credits: null,
      created_at: new Date(Date.now() + opts.phases.indexOf(spec)).toISOString(),
    });
  }
  for (const spec of opts.phases) {
    for (const dep of spec.dependsOn ?? []) {
      db.state.deps.push({
        workflow_id: workflowId,
        task_id: taskIdByPhase.get(spec.phase),
        depends_on_task_id: taskIdByPhase.get(dep),
      });
    }
  }

  return { workflowId, taskIdByPhase };
}
