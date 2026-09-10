import type { FastifyInstance } from "fastify";
import type { AuthedUser } from "../types/index.js";
import { assertProAccess } from "./gate.js";
import { defaultProviderRegistry, selectProviderFor, type ProviderOperation } from "./providers.js";

// SPLEX Pro Executive Orchestrator — items 5-8, 21. Scope of THIS file,
// stated plainly: complexity classification and Task Execution Graph
// construction, both fully offline and deterministic. It does NOT execute
// the graph (no provider.call() happens from here) — that needs real
// budget enforcement, retries, and checkpointing atop this, which is
// substantial enough on its own to not rush alongside everything else in
// this pass. What this proves, for real, is the actual intelligence-
// architecture question: given an objective, can SPLEX decide HOW to
// decompose it, with correct dependencies and capability-matched
// provider assignments — not yet whether it can run that plan against
// real providers, which don't exist in this codebase yet anyway (see
// providers.ts's own header).

export type WorkflowComplexity = "simple" | "collaborative";

// Canonical phases this planner can produce, in the SAME shape as item
// 20's own worked example (Understand -> Research/Architecture in
// parallel -> Implementation -> Review -> Critique -> Improve -> Verify ->
// Synthesis) — trimmed to only the phases a given objective's signals
// actually justify. "requirements" and "synthesis" are always present:
// every collaborative workflow needs a starting understanding step and a
// single coherent closing result (item 20's own "the user experiences
// this as ONE SPLEX workflow, not five separate AI conversations").
type Phase = "requirements" | "research" | "architecture" | "implementation" | "review" | "verification" | "synthesis";

interface PhaseSpec {
  phase: Phase;
  objective: string;
  operation: ProviderOperation;
  requiredCapabilities: string[];
  dependsOn: Phase[];
}

// Deterministic keyword signal, deliberately the SAME "count real evidence,
// don't guess" philosophy cortex/classify.ts already uses for ordinary
// chat routing (see that file) rather than a second, differently-reasoned
// classifier (item 39: reuse, don't duplicate a subsystem's APPROACH even
// where the concrete code can't be shared).
const SIGNALS: Record<Exclude<Phase, "requirements" | "synthesis">, RegExp> = {
  research: /\b(research|investigate|current|latest|up[- ]to[- ]date|documentation|standards?|compliance)\b/i,
  architecture: /\b(architect(ure)?|design (the|a|an)|system design|schema|data model|plan(ning)?)\b/i,
  implementation: /\b(build|implement|develop|code|write (the )?(code|backend|frontend|api))\b/i,
  review: /\b(review|inspect|audit|check (the|for))\b/i,
  verification: /\b(test|verify|verification|validate|deploy|production[- ]ready)\b/i,
};

// item 21: "Do NOT use multi-AI collaboration unnecessarily." Collaborative
// only when at least TWO distinct phase signals are present — one signal
// alone ("build a function", "test this") is exactly the single-capability
// case a single provider already handles well; it is the CONJUNCTION of
// distinct capability types (research AND implementation, or architecture
// AND implementation AND verification, ...) that genuinely benefits from
// more than one system, matching item 20's own example objective, which
// names research, design, implementation, review, testing and deployment
// all at once.
export function classifyObjectiveComplexity(objective: string): WorkflowComplexity {
  const hits = Object.values(SIGNALS).filter((re) => re.test(objective));
  return hits.length >= 2 ? "collaborative" : "simple";
}

export interface TaskExecutionGraph {
  phases: PhaseSpec[];
}

// Builds the graph, matching item 6/7/8 exactly: research and architecture
// depend on requirements alone (independent of each other -> can run in
// PARALLEL, per item 7's own worked example), implementation depends on
// BOTH (a multi-prerequisite node, the exact shape a single parent_task_id
// column cannot express — see migration 0061's header for why
// pro_task_dependencies is a real edge table), review/verification/
// synthesis form the sequential tail (item 8).
export function buildTaskExecutionGraph(objective: string): TaskExecutionGraph {
  const needs = (phase: Exclude<Phase, "requirements" | "synthesis">) => SIGNALS[phase].test(objective);

  const phases: PhaseSpec[] = [
    { phase: "requirements", objective: "Understand the objective, requirements, constraints and deliverables.", operation: "analyze", requiredCapabilities: ["reasoning"], dependsOn: [] },
  ];

  if (needs("research")) {
    phases.push({ phase: "research", objective: "Research current information, standards and relevant technology.", operation: "research", requiredCapabilities: ["web_research"], dependsOn: ["requirements"] });
  }
  if (needs("architecture")) {
    phases.push({ phase: "architecture", objective: "Produce a system architecture and execution plan.", operation: "plan", requiredCapabilities: ["planning", "architecture"], dependsOn: ["requirements"] });
  }
  if (needs("implementation")) {
    const implDeps: Phase[] = phases.filter((p) => p.phase === "research" || p.phase === "architecture").map((p) => p.phase);
    phases.push({ phase: "implementation", objective: "Implement the solution.", operation: "code", requiredCapabilities: ["coding"], dependsOn: implDeps.length > 0 ? implDeps : ["requirements"] });
  }
  if (needs("review")) {
    const reviewDep: Phase = phases.some((p) => p.phase === "implementation") ? "implementation" : "requirements";
    phases.push({ phase: "review", objective: "Independently review the work for issues.", operation: "review", requiredCapabilities: ["review", "critique"], dependsOn: [reviewDep] });
  }
  if (needs("verification")) {
    const verifyDep: Phase = phases.some((p) => p.phase === "review") ? "review" : phases.some((p) => p.phase === "implementation") ? "implementation" : "requirements";
    phases.push({ phase: "verification", objective: "Verify correctness, quality and completeness.", operation: "analyze", requiredCapabilities: ["verification"], dependsOn: [verifyDep] });
  }

  const tail = phases[phases.length - 1].phase;
  phases.push({ phase: "synthesis", objective: "Produce one coherent final result for the user.", operation: "generate", requiredCapabilities: ["synthesis"], dependsOn: [tail] });

  return { phases };
}

export interface CreateProWorkflowResult {
  complexity: WorkflowComplexity;
  // Populated only when complexity === "collaborative" — a simple
  // objective creates NO pro_workflows row at all (item 21: not every
  // request should spin up a graph).
  workflowId?: string;
  taskCount?: number;
  message: string;
}

// The one entry point a route calls. assertProAccess runs FIRST, before
// any classification or DB write — see gate.ts's own doc comment for why
// that ordering is the actual enforcement, not the route wrapper around it.
export async function createProWorkflow(
  fastify: FastifyInstance,
  user: AuthedUser,
  objective: string,
): Promise<CreateProWorkflowResult> {
  assertProAccess(fastify, user);

  const complexity = classifyObjectiveComplexity(objective);
  if (complexity === "simple") {
    return {
      complexity,
      message: "This can be handled by a single model — SPLEX Pro's multi-AI collaboration isn't needed here.",
    };
  }

  const graph = buildTaskExecutionGraph(objective);
  const registry = defaultProviderRegistry();

  const { data: workflow, error: workflowError } = await fastify.supabaseAdmin
    .from("pro_workflows")
    .insert({ user_id: user.id, objective, status: "DECOMPOSING", plan: { phases: graph.phases.map((p) => p.phase) } })
    .select("id")
    .single();
  if (workflowError || !workflow) {
    throw new Error(`failed to create pro_workflows row: ${workflowError?.message}`);
  }
  const workflowId = workflow.id as string;

  const idByPhase = new Map<Phase, string>();
  for (const spec of graph.phases) {
    const provider = selectProviderFor(spec.operation, registry);
    const { data: task, error: taskError } = await fastify.supabaseAdmin
      .from("pro_tasks")
      .insert({
        workflow_id: workflowId,
        objective: spec.objective,
        required_capabilities: spec.requiredCapabilities,
        assigned_provider: provider?.name ?? null,
        status: "PENDING",
      })
      .select("id")
      .single();
    if (taskError || !task) {
      throw new Error(`failed to create pro_tasks row for phase ${spec.phase}: ${taskError?.message}`);
    }
    idByPhase.set(spec.phase, task.id as string);
  }

  const edges = graph.phases.flatMap((spec) =>
    spec.dependsOn.map((dep) => ({
      workflow_id: workflowId,
      task_id: idByPhase.get(spec.phase),
      depends_on_task_id: idByPhase.get(dep),
    })),
  );
  if (edges.length > 0) {
    const { error: depError } = await fastify.supabaseAdmin.from("pro_task_dependencies").insert(edges);
    if (depError) {
      throw new Error(`failed to create pro_task_dependencies rows: ${depError.message}`);
    }
  }

  await fastify.supabaseAdmin.from("pro_workflows").update({ status: "WAITING_FOR_TASKS" }).eq("id", workflowId);

  return {
    complexity,
    workflowId,
    taskCount: graph.phases.length,
    message: `Decomposed into ${graph.phases.length} tasks across ${graph.phases.filter((p) => p.dependsOn.length === 0).length === 1 ? "a linear-with-parallel" : "a"} execution graph.`,
  };
}
