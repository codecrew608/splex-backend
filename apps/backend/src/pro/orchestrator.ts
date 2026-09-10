import type { FastifyInstance } from "fastify";
import type { AuthedUser } from "../types/index.js";
import { assertProAccess } from "./gate.js";
import { defaultProviderRegistry, selectProviderFor, type ProviderOperation } from "./providers.js";
import { optimizeProObjective } from "./objectiveOptimization.js";

// SPLEX Pro Executive Orchestrator — items 5-8, 14, 21. Complexity
// classification and Task Execution Graph construction, fully offline and
// deterministic. Execution itself (provider.call(), retries, budget
// enforcement, checkpointing) lives in execution.ts — see that file's own
// header. What this proves is the intelligence-architecture question:
// given an objective, can SPLEX decide HOW to decompose it, with correct
// dependencies, capability-matched provider assignments, and — as of this
// pass — a genuine choice among item 14's named collaboration patterns,
// not just one fixed shape.

export type WorkflowComplexity = "simple" | "collaborative";

// Canonical phases this planner can produce. "architecture_alt" and
// "debate_synthesis" exist only when the debate pattern triggers (see
// DEBATE_SIGNAL below); "revision" exists only when both implementation
// and review are present (see the loop-insertion logic in
// buildTaskExecutionGraph). "requirements" and "synthesis" are always
// present: every collaborative workflow needs a starting understanding
// step and a single coherent closing result (item 20's own "the user
// experiences this as ONE SPLEX workflow, not five separate AI
// conversations").
type Phase =
  | "requirements"
  | "research"
  | "architecture"
  | "architecture_alt"
  | "debate_synthesis"
  | "implementation"
  | "review"
  | "revision"
  | "verification"
  | "synthesis";

interface PhaseSpec {
  phase: Phase;
  objective: string;
  operation: ProviderOperation;
  requiredCapabilities: string[];
  dependsOn: Phase[];
  // Set only for debate branches (item 14): forces execution.ts to
  // actually use two DIFFERENT providers for the two branches, rather
  // than both independently re-deriving the same cheapest-capable pick —
  // which would silently collapse "debate" into "the same answer twice".
  preferredProvider?: string;
}

// Deterministic keyword signal, deliberately the SAME "count real evidence,
// don't guess" philosophy cortex/classify.ts already uses for ordinary
// chat routing (see that file) rather than a second, differently-reasoned
// classifier (item 39: reuse, don't duplicate a subsystem's APPROACH even
// where the concrete code can't be shared).
const SIGNALS: Record<Exclude<Phase, "requirements" | "synthesis" | "architecture_alt" | "debate_synthesis" | "revision">, RegExp> = {
  research: /\b(research|investigate|current|latest|up[- ]to[- ]date|documentation|standards?|compliance)\b/i,
  architecture: /\b(architect(ure)?|design (the|a|an)|system design|schema|data model|plan(ning)?)\b/i,
  implementation: /\b(build|implement|develop|code|write (the )?(code|backend|frontend|api))\b/i,
  review: /\b(review|inspect|audit|check (the|for))\b/i,
  verification: /\b(test|verify|verification|validate|deploy|production[- ]ready)\b/i,
};

// Item 14's "Debate" pattern: two independent AIs each try the same
// sub-question, a third synthesizes/judges between them. Triggered
// independently of the 5 signals above (a request can ask to "compare
// two approaches" without containing "architecture"-flavored words at
// all) — deliberately NOT counted toward classifyObjectiveComplexity's
// own threshold, since debate is a shape modifier applied to an already-
// collaborative workflow, not a complexity signal of its own.
// (?:\w+\s+){0,3} between the verb and its object is load-bearing, not
// decoration — found live by this file's own test suite: "compare two
// approaches" (a completely ordinary way to phrase this) does NOT match
// "compare" immediately followed by "approaches"; real phrasing almost
// always has "two"/"these"/"the" in between.
const DEBATE_SIGNAL = /\b(compare|evaluate)\s+(?:\w+\s+){0,3}(approaches|options|alternatives)|which\s+(approach|option|is better)|pros\s+and\s+cons|debate|two\s+(different\s+)?(perspectives|opinions)/i;

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

// Builds the graph. Base shape matches item 6/7/8 exactly: research and
// architecture depend on requirements alone (independent of each other ->
// PARALLEL, item 7's own worked example), implementation depends on
// whichever of them are present (a multi-prerequisite node — the exact
// shape a single parent_task_id column cannot express, see migration
// 0061's header for why pro_task_dependencies is a real edge table).
//
// Two of item 14's patterns are applied as structural modifiers on top of
// that base shape, rather than being separate hard-coded pipelines:
//   - DEBATE: when DEBATE_SIGNAL fires and architecture is needed, the
//     single architecture phase becomes TWO parallel branches
//     (architecture / architecture_alt) on two DIFFERENT providers, then
//     a debate_synthesis phase judges between them — matching item 14's
//     own "AI A -> Judge/Synthesizer <- AI B" diagram exactly. Everything
//     downstream depends on the judged result, not on either raw branch.
//   - REVIEW-AS-LOOP / ITERATIVE REFINEMENT: when BOTH implementation and
//     review are present, a revision phase is inserted depending on BOTH
//     — matching item 14's "Builder -> Reviewer -> Critique -> Builder"
//     diagram. This is the same underlying mechanism item 14 also calls
//     "Iterative refinement" (Draft -> Critique -> Improvement ->
//     Verification -> Final): both are fundamentally a produce-critique-
//     revise loop, so this pass implements one real loop rather than two
//     near-identical code paths for two names that describe the same
//     shape.
// "Independent verification" (item 14's third pattern beyond Sequential/
// Parallel) is enforced at DISPATCH time, not graph-construction time —
// see execution.ts's enforceIndependentReview, which excludes whichever
// provider produced a review/verification task's own parent artifacts
// from that task's candidate list.
export function buildTaskExecutionGraph(objective: string): TaskExecutionGraph {
  const needs = (phase: "research" | "architecture" | "implementation" | "review" | "verification") => SIGNALS[phase].test(objective);
  const wantsDebate = DEBATE_SIGNAL.test(objective);

  const phases: PhaseSpec[] = [
    { phase: "requirements", objective: "Understand the objective, requirements, constraints and deliverables.", operation: "analyze", requiredCapabilities: ["reasoning"], dependsOn: [] },
  ];

  if (needs("research")) {
    phases.push({ phase: "research", objective: "Research current information, standards and relevant technology.", operation: "research", requiredCapabilities: ["web_research"], dependsOn: ["requirements"] });
  }

  // architecture, with the debate modifier applied when signaled.
  let architectureTail: Phase | null = null;
  if (needs("architecture")) {
    if (wantsDebate) {
      phases.push(
        { phase: "architecture", objective: "Produce a system architecture and execution plan — approach A.", operation: "plan", requiredCapabilities: ["planning", "architecture"], dependsOn: ["requirements"], preferredProvider: "openai" },
        { phase: "architecture_alt", objective: "Produce a system architecture and execution plan — approach B. Take a genuinely different technical approach than a typical first answer would, not a minor variation.", operation: "plan", requiredCapabilities: ["planning", "architecture"], dependsOn: ["requirements"], preferredProvider: "anthropic" },
        { phase: "debate_synthesis", objective: "Compare architecture approach A and approach B on their actual merits, and produce ONE judged, coherent architecture decision — do not just concatenate both.", operation: "review", requiredCapabilities: ["review", "synthesis"], dependsOn: ["architecture", "architecture_alt"], preferredProvider: "gemini" },
      );
      architectureTail = "debate_synthesis";
    } else {
      phases.push({ phase: "architecture", objective: "Produce a system architecture and execution plan.", operation: "plan", requiredCapabilities: ["planning", "architecture"], dependsOn: ["requirements"] });
      architectureTail = "architecture";
    }
  }

  if (needs("implementation")) {
    const implDeps: Phase[] = [
      ...(phases.some((p) => p.phase === "research") ? (["research"] as const) : []),
      ...(architectureTail ? [architectureTail] : []),
    ];
    phases.push({ phase: "implementation", objective: "Implement the solution.", operation: "code", requiredCapabilities: ["coding"], dependsOn: implDeps.length > 0 ? implDeps : ["requirements"] });
  }

  if (needs("review")) {
    const reviewDep: Phase = phases.some((p) => p.phase === "implementation") ? "implementation" : "requirements";
    phases.push({ phase: "review", objective: "Independently review the work for issues.", operation: "review", requiredCapabilities: ["review", "critique"], dependsOn: [reviewDep] });
  }

  // Review-as-loop / iterative refinement (item 14): only meaningful when
  // there is both something to revise (implementation) and a critique to
  // revise it against (review) — a review with nothing to act on, or an
  // implementation nobody critiqued, has nothing for a revision step to
  // do.
  let postReviewTail: Phase | null = null;
  if (phases.some((p) => p.phase === "implementation") && phases.some((p) => p.phase === "review")) {
    phases.push({ phase: "revision", objective: "Revise the implementation to address every issue the review raised.", operation: "code", requiredCapabilities: ["coding"], dependsOn: ["implementation", "review"] });
    postReviewTail = "revision";
  } else if (phases.some((p) => p.phase === "review")) {
    postReviewTail = "review";
  } else if (phases.some((p) => p.phase === "implementation")) {
    postReviewTail = "implementation";
  }

  if (needs("verification")) {
    const verifyDep: Phase = postReviewTail ?? "requirements";
    phases.push({ phase: "verification", objective: "Independently verify correctness, quality and completeness. State clearly whether this PASSES or FAILS, and why.", operation: "analyze", requiredCapabilities: ["verification"], dependsOn: [verifyDep] });
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

  // Both classification above and graph-shaping below read the objective
  // by REGEX SIGNAL (research/architecture/implementation/review/
  // verification keywords) — the same reason handlers/chat.ts always
  // classifies on the ORIGINAL message before any optimization touches
  // it (see that file's own classificationPromise comment). Building the
  // graph from a possibly-compressed paraphrase risks losing the exact
  // wording those signals depend on; optimizing only AFTER the graph
  // shape is already decided avoids that risk while still compressing
  // what actually gets stored/sent downstream — see
  // objectiveOptimization.ts's own header for why this is a direct
  // primitive-reuse integration, not a duplicate of the chat-message
  // optimizer.
  const graph = buildTaskExecutionGraph(objective);
  const { text: optimizedObjective } = await optimizeProObjective(fastify, user.planTier, user.id, objective);
  const registry = defaultProviderRegistry(fastify);

  const { data: workflow, error: workflowError } = await fastify.supabaseAdmin
    .from("pro_workflows")
    .insert({ user_id: user.id, objective: optimizedObjective, status: "DECOMPOSING", plan: { phases: graph.phases.map((p) => p.phase) } })
    .select("id")
    .single();
  if (workflowError || !workflow) {
    throw new Error(`failed to create pro_workflows row: ${workflowError?.message}`);
  }
  const workflowId = workflow.id as string;

  const idByPhase = new Map<Phase, string>();
  for (const spec of graph.phases) {
    // A debate branch's preferredProvider (set explicitly above) wins
    // over the ordinary cheapest-capable pick — that's the whole point of
    // forcing two genuinely different providers onto the two branches.
    // Falls back to selectProviderFor's normal ranking for every other
    // phase, and even for a debate branch if its preferred provider isn't
    // actually in the registry/capable (e.g., unconnected in this
    // environment) — never a hard failure over a provider PREFERENCE.
    const preferred = spec.preferredProvider ? registry.find((p) => p.name === spec.preferredProvider && p.supports(spec.operation)) : null;
    const provider = preferred ?? selectProviderFor(spec.operation, registry);
    const { data: task, error: taskError } = await fastify.supabaseAdmin
      .from("pro_tasks")
      .insert({
        workflow_id: workflowId,
        objective: spec.objective,
        required_capabilities: spec.requiredCapabilities,
        assigned_provider: provider?.name ?? null,
        operation: spec.operation,
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
