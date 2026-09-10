import { describe, it, expect, vi, beforeEach } from "vitest";

// Same reasoning as optimizer-pipeline.test.ts: completeOnceWithFallback
// is mocked directly (not completeOnce) because it calls completeOnce
// internally, within the same module — a same-module self-call vi.mock's
// spread-and-replace pattern does not reliably intercept.
vi.mock("../src/openrouter/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/openrouter/client.js")>();
  return { ...actual, completeOnceWithFallback: vi.fn() };
});

import { completeOnceWithFallback } from "../src/openrouter/client.js";
import { classifyObjectiveComplexity, buildTaskExecutionGraph, createProWorkflow } from "../src/pro/orchestrator.js";
import { ProUnavailableError } from "../src/pro/gate.js";
import type { AuthedUser } from "../src/types/index.js";

const mockedComplete = vi.mocked(completeOnceWithFallback);

beforeEach(() => {
  mockedComplete.mockReset();
});

function completeResult(content: string) {
  return { content, usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 }, generationId: "gen-orch", citations: [] };
}

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

  it("sequential tail: review depends on implementation, and — since both implementation and review are present — a revision phase (item 14's review-as-loop) sits between review and verification", () => {
    const graph = buildTaskExecutionGraph("Build the backend, review the code, and verify it's ready to deploy.");
    const review = graph.phases.find((p) => p.phase === "review");
    const revision = graph.phases.find((p) => p.phase === "revision");
    const verification = graph.phases.find((p) => p.phase === "verification");
    expect(review?.dependsOn).toEqual(["implementation"]);
    expect(revision?.dependsOn).toEqual(expect.arrayContaining(["implementation", "review"]));
    expect(verification?.dependsOn).toEqual(["revision"]);
  });

  it("without a review phase, verification depends directly on implementation — no revision loop with nothing to revise against", () => {
    const graph = buildTaskExecutionGraph("Build the backend and verify it's ready to deploy.");
    expect(graph.phases.some((p) => p.phase === "revision")).toBe(false);
    const verification = graph.phases.find((p) => p.phase === "verification");
    expect(verification?.dependsOn).toEqual(["implementation"]);
  });

  it("every non-requirements, non-synthesis phase has a capability-matched operation from item 4's set", () => {
    const graph = buildTaskExecutionGraph("Research, design, implement, review and verify a full application.");
    const validOps = new Set(["plan", "reason", "generate", "analyze", "review", "research", "code", "tool_call"]);
    for (const phase of graph.phases) {
      expect(validOps.has(phase.operation)).toBe(true);
    }
  });
});

describe("buildTaskExecutionGraph — item 14's Debate pattern", () => {
  it("without debate language, architecture stays a single phase", () => {
    const graph = buildTaskExecutionGraph("Design the system architecture for a new service.");
    expect(graph.phases.filter((p) => p.phase === "architecture" || p.phase === "architecture_alt").map((p) => p.phase)).toEqual(["architecture"]);
    expect(graph.phases.some((p) => p.phase === "debate_synthesis")).toBe(false);
  });

  it("debate language splits architecture into two parallel branches on two DIFFERENT preferred providers, judged by a third", () => {
    const graph = buildTaskExecutionGraph("Compare two approaches to the system architecture and tell me which approach is better.");
    const a = graph.phases.find((p) => p.phase === "architecture");
    const b = graph.phases.find((p) => p.phase === "architecture_alt");
    const synth = graph.phases.find((p) => p.phase === "debate_synthesis");
    expect(a?.dependsOn).toEqual(["requirements"]);
    expect(b?.dependsOn).toEqual(["requirements"]);
    expect(a?.preferredProvider).toBeDefined();
    expect(b?.preferredProvider).toBeDefined();
    expect(a?.preferredProvider).not.toBe(b?.preferredProvider);
    expect(synth?.dependsOn).toEqual(expect.arrayContaining(["architecture", "architecture_alt"]));
  });

  it("downstream implementation depends on the JUDGED debate result, never on either raw branch directly", () => {
    const graph = buildTaskExecutionGraph("Compare two approaches to the architecture, then build it.");
    const implementation = graph.phases.find((p) => p.phase === "implementation");
    expect(implementation?.dependsOn).toContain("debate_synthesis");
    expect(implementation?.dependsOn).not.toContain("architecture");
    expect(implementation?.dependsOn).not.toContain("architecture_alt");
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
      // Reached by optimizeProObjective's resolveOptimizerModelPricing
      // lookup whenever a mocked semantic call actually succeeds — always
      // "not found", which resolveOptimizerModelPricing's own graceful
      // fallback (a small nominal rate) already handles, matching
      // production's real behavior for a model with no registry row.
      if (table === "model_registry") {
        const api: Record<string, unknown> = {};
        const chain = () => api;
        Object.assign(api, { select: chain, eq: chain, order: chain, maybeSingle: async () => ({ data: null, error: null }) });
        return api;
      }
      throw new Error(`unexpected table in pro DB stub: ${table}`);
    },
  };

  return { supabaseAdmin, workflows, tasks, dependencies };
}

function fastifyWith(enabled: boolean, db = makeProDbStub()) {
  const log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
  return { config: { SPLEX_PRO_ENABLED: enabled, PROMPT_OPTIMIZER_MODEL_ID: "test/optimizer-model" }, supabaseAdmin: db.supabaseAdmin, log } as never;
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

describe("createProWorkflow — Prompt Optimizer integration (spec item 8)", () => {
  // Long enough to clear MIN_TOKENS_FOR_SEMANTIC (80 tokens ~320 chars)
  // with real margin, and carries every research/architecture/
  // implementation/review/verification signal word buildTaskExecutionGraph
  // depends on, so the graph-shape assertions below have something real
  // to check regardless of what the (mocked) optimizer returns.
  const VERBOSE_OBJECTIVE =
    "Please research current best practices thoroughly, then design a proper system architecture, " +
    "then implement and build the actual solution, then review the code carefully for issues, and " +
    "finally verify and test that everything is genuinely production-ready before we consider this done. " +
    "I want this done really well since it matters a lot for the team and the timeline is somewhat tight.";

  it("a short objective passes through unoptimized — below the semantic threshold, same as chat", async () => {
    const db = makeProDbStub();
    const result = await createProWorkflow(fastifyWith(true, db), user(), "Research and build a small tool.");
    expect(result.workflowId).toBeDefined();
    expect(db.workflows[result.workflowId!]?.objective).toBe("Research and build a small tool.");
    expect(mockedComplete).not.toHaveBeenCalled();
  });

  it("a genuinely verbose objective is compressed before being stored — the STORED objective differs from the raw input", async () => {
    mockedComplete.mockResolvedValue(
      completeResult("TASK: Research best practices, design architecture, implement, review, and verify production-readiness."),
    );
    const db = makeProDbStub();
    const result = await createProWorkflow(fastifyWith(true, db), user(), VERBOSE_OBJECTIVE);
    expect(mockedComplete).toHaveBeenCalled();
    const storedObjective = db.workflows[result.workflowId!]?.objective as string;
    expect(storedObjective).not.toBe(VERBOSE_OBJECTIVE);
    expect(storedObjective).toContain("Research");
  });

  it("the graph SHAPE is decided from the ORIGINAL wording, not a possibly-compressed paraphrase — every signaled phase is still present even when the optimizer aggressively rewords the objective", async () => {
    // Deliberately drops every recognizable signal word an optimizer
    // might legitimately produce as a "cleaner" paraphrase, to prove the
    // graph shape does NOT depend on what the optimizer returns.
    mockedComplete.mockResolvedValue(completeResult("Do the needful across the whole lifecycle end to end."));
    const db = makeProDbStub();
    const result = await createProWorkflow(fastifyWith(true, db), user(), VERBOSE_OBJECTIVE);
    const phaseNames = (db.workflows[result.workflowId!]?.plan as { phases: string[] }).phases;
    expect(phaseNames).toEqual(expect.arrayContaining(["research", "architecture", "implementation", "review", "verification"]));
  });

  it("original-prompt fallback: a failed semantic call still produces a real, working workflow — never blocks workflow creation", async () => {
    mockedComplete.mockRejectedValue(new Error("optimizer upstream down"));
    const db = makeProDbStub();
    const result = await createProWorkflow(fastifyWith(true, db), user(), VERBOSE_OBJECTIVE);
    expect(result.workflowId).toBeDefined();
    expect(db.workflows[result.workflowId!]?.objective).toBe(VERBOSE_OBJECTIVE);
  });

  it("bypass-when-unnecessary: a SIMPLE objective never reaches the optimizer at all — no workflow, no optimization attempt", async () => {
    const db = makeProDbStub();
    const result = await createProWorkflow(fastifyWith(true, db), user(), "What is 2 + 2?");
    expect(result.complexity).toBe("simple");
    expect(result.workflowId).toBeUndefined();
    expect(mockedComplete).not.toHaveBeenCalled();
  });
});
