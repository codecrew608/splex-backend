import type { ComplexityLevel } from "../shared-types.js";
import type { ModelRegistryRow, ModelHealthRow } from "../types/index.js";
import type { CortexVersion } from "./version.js";

// Task shapes that want materially different trade-offs. Derived from
// (category, complexity) — see resolveRoutingProfile. v1 (Free) never
// resolves into one of these — it always scores with V1_FLAT_WEIGHTS
// below, which is the actual architectural split between the two engine
// versions: v1.5 doesn't just see a bigger model pool, its SCORING
// FUNCTION genuinely behaves differently (task-shape-aware weighting,
// category-specific capability fit, live health blending, provider-
// diversified fallback — none of which v1 does).
export type RoutingProfile = "cheap_fast" | "coding" | "deep_quality" | "media";

export interface ScoredModel {
  model: ModelRegistryRow;
  score: number;
  // Kept for structured logging / observability — never sent to a client.
  breakdown: {
    quality: number;
    capabilityFit: number;
    reliability: number;
    costPenalty: number;
    latencyPenalty: number;
  };
}

interface ProfileWeights {
  quality: number;
  capabilityFit: number;
  reliability: number;
  cost: number;
  latency: number;
}

// Weights encode the spec's stated priorities per task shape. They're
// relative, not absolute — what matters is their ordering within a
// profile, since every component below is normalized to roughly 0-100
// before weighting.
const PROFILE_WEIGHTS: Record<RoutingProfile, ProfileWeights> = {
  // "Simple question: cost > latency > maximum quality"
  cheap_fast: { quality: 0.5, capabilityFit: 0.5, reliability: 1.0, cost: 2.0, latency: 1.2 },
  // "Coding: coding quality > reliability > cost"
  //
  // Same defect as deep_quality (see its comment): verified against real
  // migration-0032 prices, cost 0.7 let a much cheaper coding_score-80
  // candidate (Flash) outscore the coding_score-92 primary (GLM) outright —
  // a 62-point cost-penalty spread beat a 24-point capabilityFit spread even
  // at 2.0x weight. Rebalanced the same way: cost weight materially lower,
  // capabilityFit weight higher, re-verified against the real scoring
  // function (cortex/routing.test.ts) for the whole approved pool, not just
  // the pair that first exposed it.
  coding: { quality: 1.0, capabilityFit: 2.4, reliability: 1.4, cost: 0.35, latency: 0.4 },
  // "Complex workflow: quality > reliability > cost > latency"
  //
  // cost was 0.8 and capabilityFit 1.2. Verified against migration 0032's
  // REAL prices (not the stale figures the registry had before it): with
  // those weights, GLM 5.2 — the spec's stated primary for reasoning,
  // research, writing and complex general chat — lost to cheaper candidates
  // in every one of those categories, because cost's log-scaled spread
  // across this five-model pool (~62 points) exceeded quality's spread
  // (~12 points raw, ~14 points even at the old 1.2x) by enough to dominate
  // regardless of which model was actually better. "Quality > cost" was true
  // in the comment and false in the arithmetic. Rebalanced so it is true in
  // both, and re-verified against the full pool (see cortex/routing.test.ts
  // for the worked cases this was checked against, including the ones that
  // motivated the change).
  deep_quality: { quality: 2.0, capabilityFit: 1.6, reliability: 1.5, cost: 0.35, latency: 0.3 },
  // "Media generation: quality > cost > latency"
  media: { quality: 2.0, capabilityFit: 1.0, reliability: 1.2, cost: 1.0, latency: 0.3 },
};

const MEDIA_CATEGORIES = new Set(["image", "audio", "video", "ppt"]);

// v1 (Free)'s ENTIRE routing profile: one flat, task-shape-blind weighting
// — no coding/deep_quality/media differentiation at all. This is what
// "Basic complexity analysis, Standard model scoring" actually means
// architecturally: v1 never calls resolveRoutingProfile, so the same
// weights apply whether the request is a one-line greeting or a math
// problem. Intentionally close to cheap_fast's own tuning (a defensible
// "cheap and reasonable" default for a free tier) but kept as an
// independent constant so v1's behavior can't silently drift if
// cheap_fast's own tuning is ever adjusted for v1.5.
const V1_FLAT_WEIGHTS: ProfileWeights = { quality: 0.6, capabilityFit: 0.4, reliability: 0.9, cost: 1.8, latency: 1.0 };

export function resolveRoutingProfile(category: string, complexity: ComplexityLevel): RoutingProfile {
  if (MEDIA_CATEGORIES.has(category)) return "media";
  if (category === "coding") return "coding";
  // Deep research is inherently high-effort/multi-stage regardless of the
  // triggering message's own complexity score (same reasoning as
  // workflow's fixed STEP_COMPLEXITY) — quality of synthesis matters more
  // than shaving cost on any one stage. Ordinary web_search stays
  // complexity-driven like a normal question: most searches are a quick
  // fact lookup (cheap_fast is right), but one phrased as a genuinely
  // complex request still gets deep_quality below.
  if (category === "deep_research") return "deep_quality";
  if (complexity === "complex" || category === "reasoning" || category === "math") return "deep_quality";
  return "cheap_fast";
}

// Which per-model score answers "how good is this model at THIS task".
// Falls back through quality_score to capability_score so rows predating
// migration 0014 (or any row where a specific score was never set) still
// rank sensibly rather than scoring 0.
function capabilityFitFor(model: ModelRegistryRow, category: string): number {
  const fallback = model.quality_score ?? model.capability_score;
  if (category === "coding") return model.coding_score ?? fallback;
  if (category === "reasoning" || category === "math") return model.reasoning_score ?? fallback;
  return fallback;
}

// Token pricing varies over orders of magnitude ($0 free models up to
// several dollars per million), so a linear penalty would let one
// expensive candidate dominate every other signal. Log scale keeps the
// penalty meaningful without letting it swamp quality entirely.
// Normalized so $0 -> 0 penalty and ~$10/M -> ~100.
function costPenaltyFor(model: ModelRegistryRow): number {
  const blended = model.cost_per_million_input + model.cost_per_million_output * 3; // output tokens dominate real spend
  if (blended <= 0) return 0;
  return Math.min(100, (Math.log10(1 + blended) / Math.log10(41)) * 100);
}

// Live health beats configured guesses when we actually have observations.
// Below MIN_OBSERVATIONS the sample is too small to be meaningful (one
// unlucky 429 shouldn't bench a good model), so the configured
// reliability_score carries it.
const MIN_OBSERVATIONS = 3;

function reliabilityFor(model: ModelRegistryRow, health: ModelHealthRow | undefined): number {
  const configured = model.reliability_score ?? 70;
  if (!health) return configured;

  const total = health.success_count + health.failure_count + health.timeout_count;
  if (total < MIN_OBSERVATIONS) return configured;

  const errorRate = (health.failure_count + health.timeout_count) / total;
  const observed = (1 - errorRate) * 100;
  // Blend rather than replace — a model with 5 observations shouldn't be
  // judged as confidently as one with 500, and this keeps a single bad
  // window from permanently overriding curated config.
  const confidence = Math.min(1, total / 20);
  return configured * (1 - confidence) + observed * confidence;
}

function latencyPenaltyFor(model: ModelRegistryRow, health: ModelHealthRow | undefined): number {
  // latency_score is "higher = faster", so the penalty inverts it.
  const configured = 100 - (model.latency_score ?? 50);
  if (!health || health.success_count < MIN_OBSERVATIONS) return configured;

  const avgMs = health.total_latency_ms / health.success_count;
  // 0ms -> 0 penalty, 30s+ -> 100. Linear here (unlike cost) because
  // real-world latency spread is roughly one order of magnitude, not five.
  return Math.min(100, (avgMs / 30_000) * 100);
}

// THE cost-aware routing score. Replaces the previous ordering
// (priority ASC, capability_score DESC), which had no notion of what a
// model costs, how fast it is, or whether it's currently failing.
//
// Deliberately deterministic and dependency-free: no LLM call, no network
// — the spec explicitly calls for deterministic logic on cheap decisions,
// and this runs on every single request.
//
// cortexVersion is where v1 and v1.5 actually diverge in BEHAVIOR, not
// just input size:
//   v1   — flat V1_FLAT_WEIGHTS regardless of category/complexity, no live
//          health blending (health data is simply never looked up for a
//          v1 candidate — reliability/latency fall back to configured
//          scores only), capability fit collapses to plain quality_score
//          (no coding_score/reasoning_score signal).
//   v1.5 — full resolveRoutingProfile task-shape weighting, live health
//          blending, category-specific capability fit.
export function scoreModels(
  models: ModelRegistryRow[],
  health: Map<string, ModelHealthRow>,
  category: string,
  complexity: ComplexityLevel,
  cortexVersion: CortexVersion,
): ScoredModel[] {
  const isV1 = cortexVersion === "v1";
  const w = isV1 ? V1_FLAT_WEIGHTS : PROFILE_WEIGHTS[resolveRoutingProfile(category, complexity)];

  return models
    .map((model) => {
      const h = isV1 ? undefined : health.get(model.id);
      const quality = model.quality_score ?? model.capability_score;
      const capabilityFit = isV1 ? quality : capabilityFitFor(model, category);
      const reliability = reliabilityFor(model, h);
      const costPenalty = costPenaltyFor(model);
      const latencyPenalty = latencyPenaltyFor(model, h);

      const score =
        w.quality * quality +
        w.capabilityFit * capabilityFit +
        w.reliability * reliability -
        w.cost * costPenalty -
        w.latency * latencyPenalty;

      return { model, score, breakdown: { quality, capabilityFit, reliability, costPenalty, latencyPenalty } };
    })
    .sort((a, b) => b.score - a.score);
}

// Prefer a different provider for the fallback candidate. OpenRouter's
// failures cluster by upstream provider (a rate-limited shared :free pool,
// a provider-wide outage) — retrying a second model from the same vendor
// is far more likely to hit the same wall, which is the exact scenario
// migration 0009 was written to address at the registry level.
export function diversifyByProvider(scored: ScoredModel[], limit: number): ScoredModel[] {
  if (scored.length <= 1) return scored.slice(0, limit);

  const picked: ScoredModel[] = [scored[0]];
  const seenProviders = new Set([scored[0].model.provider ?? scored[0].model.openrouter_model_id.split("/")[0]]);

  for (const candidate of scored.slice(1)) {
    if (picked.length >= limit) break;
    const provider = candidate.model.provider ?? candidate.model.openrouter_model_id.split("/")[0];
    if (!seenProviders.has(provider)) {
      picked.push(candidate);
      seenProviders.add(provider);
    }
  }

  // Not enough distinct providers — backfill by score so a fallback still
  // exists rather than returning a single candidate with no retry option.
  if (picked.length < limit) {
    for (const candidate of scored) {
      if (picked.length >= limit) break;
      if (!picked.includes(candidate)) picked.push(candidate);
    }
  }

  return picked;
}

// The other half of the v1/v1.5 behavioral split (alongside scoreModels
// above): v1's "Basic fallback" is a plain top-N cut of the ranked list.
// v1.5's "Better fallback selection when the primary model fails" is
// provider-diversified — see diversifyByProvider's own doc comment for why
// that materially improves retry odds over a same-provider second pick.
export function pickCandidates(scored: ScoredModel[], cortexVersion: CortexVersion, limit: number): ScoredModel[] {
  if (cortexVersion === "v1") return scored.slice(0, limit);
  return diversifyByProvider(scored, limit);
}
