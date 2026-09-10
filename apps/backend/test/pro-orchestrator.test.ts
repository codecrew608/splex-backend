import { describe, it, expect } from "vitest";
import { classifyObjectiveComplexity, buildTaskExecutionGraph, createProWorkflow } from "../src/pro/orchestrator.js";
import { ProUnavailableError } from "../src/pro/gate.js";
import type { AuthedUser } from "../src/types/index.js";

function user(overrides: Partial<AuthedUser> = {}): AuthedUser {
  return { id: "u1", email: "u1@example.com", planTier: "pro", orgId: null, timezone: "UTC", ...overrides };
}

describe("classifyObjectiveComplexity — item 21: simple tasks must remain simple", () => {
  it.each([
    "What is 342 x 719?",
    "Explain photosynthesis.",
    "Write a Python function to reverse a string.",
    "What is the capital of France?",
  ])("%s -> simple", (objective) => {
    expect(classifyObjectiveComplexity(objective)).toBe("simple");
  });

  it.each([
    "Research, design, implement and deploy a complete e-commerce application.",
    "Investigate current payment API standards, then architect and build a checkout system, and verify it's production-ready.",
  ])("%s -> collaborative", (objective) => {
    expect(classifyObjectiveComplexity(objective)).toBe("collaborative");
  });

  it("a single capability signal alone is NOT enough to trigger collaboration", () => {
    // "build" alone (implementation-only) — one signal, stays simple.
    expect(classifyObjectiveComplexity("Build a login form component.")).toBe("simple");
  });
});

describe("buildTaskExecutionGraph — items 6/7/8", () => {
  it("always includes requirements first and synthesis last", () => {
    const graph = buildTaskExecutionGraph("Research, design, implement and test a system.");
    expect(graph.phases[0].phase).toBe("requirements");
    expect(graph.phases[graph.phases.length - 1].phase).toBe("synthesis");
  });

  it("research and architecture are BOTH direct children of requirements — parallel, not sequential (item 7)", () => {
    const graph = buildTaskExecutionGraph("Research current standards and design the system architecture.");
    const research = graph.phases.find((p) => p.phase === "research");
    const architecture = graph.phases.find((p) => p.phase === "architecture");
    expect(research?.dependsOn).toEqual(["requirements"]);
    expect(architecture?.dependsOn).toEqual(["requirements"]);
  });

  it("implementation depends on BOTH research and architecture when both are present — a real multi-prerequisite node (item 6's own worked example)", () => {
    const graph = buildTaskExecutionGraph("Research standards, design the architecture, and build the implementation.");
    const impl = graph.phases.find((p) => p.phase === "implementation");
    expect(impl?.dependsOn).toEqual(expect.arrayContaining(["research", "architecture"]));
    expect(impl?.dependsOn).toHaveLength(2);
  });

  it("a phase not signalled by the objective is simply absent from the graph, not included empty", () => {
    const graph = buildTaskExecutionGraph("Research current API documentation and write a summary report.");
    expect(graph.phases.some((p) => p.phase === "implementation")).toBe(false);
    expect(graph.phases.some((p) => p.phase === "verification")).toBe(false);
  });

  it("sequential tail: review depends on implementation, verification depends on review (item 8)", () => {
    const graph = buildTaskExecutionGraph("Build the backend, review the code, and verify it's ready to deploy.");
    const review = graph.phases.find((p) => p.phase === "review");
    const verification = graph.phases.find((p) => p.phase === "verification");
    expect(review?.dependsOn).toEqual(["implementation"]);
    expect(verification?.dependsOn).toEqual(["review"]);
  });

  it("every non-requirements, non-synthesis phase has a capability-matched operation from item 4's set", () => {
    const graph = buildTaskExecutionGraph("Research, design, implement, review and verify a full application.");
    const validOps = new Set(["plan", "reason", "generate", "analyze", "review", "research", "code", "tool_call"]);
    for (const phase of graph.phases) {
      expect(validOps.has(phase.operation)).toBe(true);
    }
  });
});

// A minimal, self-contained stub — NOT the shared fakeFastify.ts (its
// query builder doesn't cover the new pro_* tables, and building that out
// is premature for a feature with zero live callers; see this file's own
// scope note). Covers exactly the .insert().select().single() /
// .update().eq() shape orchestrator.ts actually uses.
function makeProDbStub() {
  const workflows: Record<string, Record<string, unknown>> = {};
  const tasks: Array<Record<string, unknown>> = [];
  const dependencies: Array<Record<string, unknown>> = [];
  let nextId = 1;
  const id = () => `id-${nextId++}`;

  const supabaseAdmin = {
    from(table: string) {
      if (table === "pro_workflows") {
        return {
          insert(row: Record<string, unknown>) {
            const workflowId = id();
            workflows[workflowId] = { id: workflowId, ...row };
            return {
              select: () => ({
                single: async () => ({ data: { id: workflowId }, error: null }),
              }),
            };
          },
          update(patch: Record<string, unknown>) {
            return {
              eq: async (_col: string, val: string) => {
                Object.assign(workflows[val] ?? {}, patch);
                return { data: null, error: null };
              },
            };
          },
        };
      }
      if (table === "pro_tasks") {
        return {
          insert(row: Record<string, unknown>) {
            const taskId = id();
            tasks.push({ id: taskId, ...row });
            return {
              select: () => ({
                single: async () => ({ data: { id: taskId }, error: null }),
              }),
            };
          },
        };
      }
      if (table === "pro_task_dependencies") {
        return {
          insert: async (rows: Array<Record<string, unknown>>) => {
            dependencies.push(...rows);
            return { data: null, error: null };
          },
        };
      }
      throw new Error(`unexpected table in pro DB stub: ${table}`);
    },
  };

  return { supabaseAdmin, workflows, tasks, dependencies };
}

function fastifyWith(enabled: boolean, db = makeProDbStub()) {
  return { config: { SPLEX_PRO_ENABLED: enabled }, supabaseAdmin: db.supabaseAdmin } as never;
}

describe("createProWorkflow — the gate runs BEFORE anything else", () => {
  it("flag off -> throws ProUnavailableError, touches the DB zero times", async () => {
    const db = makeProDbStub();
    const insertSpy = db.supabaseAdmin.from;
    let dbTouched = false;
    db.supabaseAdmin.from = ((table: string) => {
      dbTouched = true;
      return insertSpy(table);
    }) as never;

    await expect(createProWorkflow(fastifyWith(false, db), user(), "Research, design and build a full app.")).rejects.toBeInstanceOf(ProUnavailableError);
    expect(dbTouched).toBe(false);
  });
});

describe("createProWorkflow — simple objectives create NO workflow row (item 21)", () => {
  it("returns complexity:'simple' with no workflowId", async () => {
    const db = makeProDbStub();
    const result = await createProWorkflow(fastifyWith(true, db), user(), "What is 2 + 2?");
    expect(result.complexity).toBe("simple");
    expect(result.workflowId).toBeUndefined();
    expect(Object.keys(db.workflows)).toHaveLength(0);
  });
});

describe("createProWorkflow — collaborative objectives persist a real graph", () => {
  it("creates one pro_workflows row and one pro_tasks row per phase", async () => {
    const db = makeProDbStub();
    const result = await createProWorkflow(
      fastifyWith(true, db),
      user(),
      "Research current standards, design the architecture, implement the system, and verify it works.",
    );
    expect(result.complexity).toBe("collaborative");
    expect(result.workflowId).toBeDefined();
    expect(db.tasks.length).toBe(result.taskCount);
    expect(db.tasks.length).toBeGreaterThanOrEqual(5); // requirements, research, architecture, implementation, verification, synthesis
  });

  it("every task row belongs to the created workflow", async () => {
    const db = makeProDbStub();
    const result = await createProWorkflow(fastifyWith(true, db), user(), "Research and implement a payment system, then verify it.");
    for (const task of db.tasks) {
      expect(task.workflow_id).toBe(result.workflowId);
    }
  });

  it("dependency edges reference real task ids created in THIS workflow, never a dangling id", async () => {
    const db = makeProDbStub();
    await createProWorkflow(fastifyWith(true, db), user(), "Research, design, implement and review a full system.");
    const realIds = new Set(db.tasks.map((t) => t.id));
    for (const edge of db.dependencies) {
      expect(realIds.has(edge.task_id)).toBe(true);
      expect(realIds.has(edge.depends_on_task_id)).toBe(true);
    }
  });

  it("the workflow ends in WAITING_FOR_TASKS, not stuck at DECOMPOSING", async () => {
    const db = makeProDbStub();
    const result = await createProWorkflow(fastifyWith(true, db), user(), "Research, design and implement a system.");
    expect(db.workflows[result.workflowId!]?.status).toBe("WAITING_FOR_TASKS");
  });
});
