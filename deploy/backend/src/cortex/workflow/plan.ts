import type { FastifyInstance } from "fastify";
import { completeOnceWithFallback } from "../../openrouter/client.js";
import { resolveClassifierModelCandidates } from "../classifierModel.js";
import type { PlanTier } from "../../shared-types.js";

export interface PlannedStep {
  title: string;
  category: string;
  detailedPrompt: string;
}

export type PlanResult =
  | { outcome: "workflow"; steps: PlannedStep[] }
  | { outcome: "clarify"; question: string }
  // Planning failed to parse, or the model decided on reflection this
  // doesn't need decomposition — caller should fall through to ordinary
  // single-shot chat, silently, exactly as if the workflow trigger had
  // never fired.
  | { outcome: "fallback" };

const VALID_CATEGORIES = ["coding", "reasoning", "math", "writing", "vision", "documents", "general"];

function buildPlannerSystemPrompt(maxSteps: number): string {
  return `You are the planning stage of SPLEX's Cortex orchestration engine. Given an outcome-oriented user request, decide whether it needs to be broken into an ordered sequence of steps to produce a complete result, and if so, plan those steps.

Respond with ONLY a JSON object, no prose, no markdown fences, matching this shape:
{"needsWorkflow": boolean, "clarificationQuestion": string | null, "steps": [{"title": string, "category": string, "detailedPrompt": string}]}

Rules:
- If the request is too ambiguous to plan confidently (missing critical details you'd genuinely need to ask about), set needsWorkflow:false and clarificationQuestion to ONE specific question. Leave steps empty.
- If the request is simple enough to just answer directly without decomposition, set needsWorkflow:false and clarificationQuestion:null.
- Otherwise set needsWorkflow:true, clarificationQuestion:null, and produce between 2 and ${maxSteps} ordered steps (${maxSteps} is a hard ceiling for this user's plan — if the full request genuinely needs more, do the best achievable version within ${maxSteps} steps rather than exceeding it). Each step's "category" MUST be exactly one of: ${VALID_CATEGORIES.join(", ")} — pick whichever best matches that step's actual work (planning/architecture steps usually fit "reasoning"; implementation steps fit "coding" or "writing" depending on the artifact).
- Each step's "detailedPrompt" must be a complete, self-contained instruction for whichever model executes that step — assume it has NOT seen the original user request, only what you write here plus the outputs of prior steps (which will be provided automatically).
- The LAST step's output is what the user actually sees, so its detailedPrompt should produce the complete, final, user-facing result — not an internal summary.`;
}

export async function planWorkflow(
  fastify: FastifyInstance,
  message: string,
  contextBlock: string,
  maxSteps: number,
  planTier: PlanTier,
): Promise<PlanResult> {
  const userContent = contextBlock ? `${contextBlock}\n\nUser request:\n${message}` : `User request:\n${message}`;

  // Tier-aware. Free users can run workflows (3 steps on the free plan),
  // so planning must not reach the configured PAID model. An empty
  // candidate list means no free model is available at all: fall back to
  // ordinary single-shot chat rather than spending — a workflow is an
  // enhancement, never worth a paid call the user's tier doesn't cover.
  //
  // completeOnceWithFallback tries every active candidate in priority
  // order, not just the top one — a single rate-limited free model used to
  // make planning fail outright (silently downgrading to single-shot chat)
  // even when another free model was available and would have worked.
  const plannerCandidates = await resolveClassifierModelCandidates(fastify, planTier);
  if (plannerCandidates.length === 0) {
    fastify.log.warn({ planTier }, "no free planner model available, falling back to single-shot chat");
    return { outcome: "fallback" };
  }

  let raw: string;
  try {
    const result = await completeOnceWithFallback(fastify, plannerCandidates, {
      messages: [
        { role: "system", content: buildPlannerSystemPrompt(maxSteps) },
        { role: "user", content: userContent },
      ],
      maxTokens: 1500,
    });
    raw = result.content;
  } catch (err) {
    fastify.log.warn({ err }, "workflow planning request failed, falling back to single-shot chat");
    return { outcome: "fallback" };
  }

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("no JSON in planner response");

    const parsed = JSON.parse(jsonMatch[0]) as {
      needsWorkflow?: boolean;
      clarificationQuestion?: string | null;
      steps?: Array<{ title?: string; category?: string; detailedPrompt?: string }>;
    };

    if (!parsed.needsWorkflow) {
      if (parsed.clarificationQuestion && parsed.clarificationQuestion.trim()) {
        return { outcome: "clarify", question: parsed.clarificationQuestion.trim() };
      }
      return { outcome: "fallback" };
    }

    const steps: PlannedStep[] = (parsed.steps ?? [])
      .filter((s): s is { title: string; category?: string; detailedPrompt: string } => Boolean(s.title && s.detailedPrompt))
      .map((s) => ({
        title: s.title,
        category: VALID_CATEGORIES.includes(s.category ?? "") ? (s.category as string) : "general",
        detailedPrompt: s.detailedPrompt,
      }))
      // Defensive hard cap — the prompt above already asks for at most
      // maxSteps, but nothing stops a model from ignoring that, and this is
      // a billed, per-step-charging path so the ceiling must hold
      // regardless of model compliance.
      .slice(0, maxSteps);

    if (steps.length === 0) throw new Error("planner returned needsWorkflow:true with no usable steps");

    return { outcome: "workflow", steps };
  } catch (err) {
    fastify.log.warn({ err, raw: raw.slice(0, 500) }, "workflow plan failed to parse, falling back to single-shot chat");
    return { outcome: "fallback" };
  }
}
