"""SPLEX System Benchmark (SSB) v1.0 — scoring the platform, not the model.

Weights and rules come from bench/SIB-v1.0-SPEC.md §3 and were fixed before
any result existed.

Most SSB inputs are measurements already produced by the live SIB run (real
routing decisions, real latencies, real successes and failures), joined
against the database for the facts SSE deliberately does not expose — the
raw model id and the credits actually charged. That join is what makes the
free/paid isolation claim a verification rather than an assumption.
"""

from __future__ import annotations

import json
import urllib.request
from collections import Counter
from pathlib import Path

from .free_models import DISTINCT_FREE_MODEL_IDS
from .sib import wilson_interval

BENCHMARK_VERSION = "SSB v1.0"

WEIGHTS: dict[str, float] = {
    "routing_accuracy": 0.20,
    "task_success": 0.20,
    "reliability": 0.15,
    "capability_selection": 0.10,
    "failure_recovery": 0.10,
    "cost_efficiency": 0.10,
    "latency": 0.10,
    "safety_isolation": 0.05,
}
assert abs(sum(WEIGHTS.values()) - 1.0) < 1e-9, "SSB weights must sum to 1.0"

# cortex/labels.ts, mirrored. A label SPLEX can emit that is missing here
# would silently score as a routing miss, so the map is asserted complete
# against the labels actually observed in a run.
LABEL_TO_CATEGORY = {
    "Software Development": "coding",
    "Advanced Reasoning": "reasoning",
    "Mathematics": "math",
    "Writing & Content": "writing",
    "Visual Understanding": "vision",
    "Image Generation": "image",
    "Audio Generation": "audio",
    "Video Generation": "video",
    "Presentation Design": "ppt",
    "Web Search": "web_search",
    "Deep Research": "deep_research",
    "Document Analysis": "documents",
    "General Assistance": "general",
}

# Pre-registered latency bands (SPEC §3.1).
LATENCY_BANDS = [(3000, 100), (6000, 85), (10000, 70), (20000, 50), (40000, 25)]

# Routing is scored with a documented tolerance, not as exact-match only.
# `general` is the router's declared catch-all: a general-purpose model
# answering a maths question is a WEAKER route than `math`, but it is not the
# same failure as sending a coding task to an image generator. Both are
# reported: `strict` (exact category) and `acceptable` (exact, or a
# defensible generalisation).
ACCEPTABLE_ALTERNATIVES: dict[str, set[str]] = {
    "math": {"math", "reasoning", "general"},
    "reasoning": {"reasoning", "math", "general"},
    "coding": {"coding", "general", "reasoning"},
    "general": {"general", "reasoning", "writing"},
    "documents": {"documents", "general", "reasoning"},
    "writing": {"writing", "general"},
    "web_search": {"web_search", "general"},
    "vision": {"vision", "documents", "general"},
    "unavailable": {"image", "audio", "video", "ppt", "general"},
}


def load_rows(path: Path, target: str) -> list[dict]:
    rows = [json.loads(l) for l in path.read_text().splitlines() if l.strip()]
    return [r for r in rows if r["target"] == target]


def load_corpus_index() -> dict[str, dict]:
    from .sib import load_corpus
    return {q["question_id"]: q for q in load_corpus()}


# ---------------------------------------------------------------------------
# Components
# ---------------------------------------------------------------------------

def routing_accuracy(rows: list[dict], corpus: dict[str, dict]) -> dict:
    strict = acceptable = n = 0
    confusion: Counter = Counter()
    unknown_labels: set[str] = set()

    for r in rows:
        label = r.get("routed_category")
        if not label:
            continue                      # no decision reached; a task-success problem
        if label not in LABEL_TO_CATEGORY:
            unknown_labels.add(label)
            continue
        got = LABEL_TO_CATEGORY[label]
        want = corpus[r["question_id"]]["expected_capability"]
        n += 1
        if got == want:
            strict += 1
            acceptable += 1
        elif got in ACCEPTABLE_ALTERNATIVES.get(want, {want}):
            acceptable += 1
        confusion[f"{want} -> {got}"] += 1

    return {
        "n": n,
        "strict_pct": (strict / n * 100) if n else None,
        "acceptable_pct": (acceptable / n * 100) if n else None,
        "strict_ci": wilson_interval(strict, n),
        "acceptable_ci": wilson_interval(acceptable, n),
        "confusion": dict(confusion.most_common()),
        "unknown_labels": sorted(unknown_labels),
    }


def task_success(rows: list[dict]) -> dict:
    """A request 'succeeded' if SPLEX returned a usable answer at all.

    Deliberately independent of whether the answer was CORRECT — that is
    SIB's job. Here a wrong-but-delivered answer counts as a successful
    task; only errors, timeouts and empty bodies count against it.
    """
    delivered = sum(1 for r in rows if r["outcome"] not in
                    ("PROVIDER_UNAVAILABLE", "TIMEOUT", "SPLEX_ERROR"))
    n = len(rows)
    return {
        "n": n, "delivered": delivered,
        "pct": (delivered / n * 100) if n else None,
        "ci": wilson_interval(delivered, n),
        "failures": dict(Counter(r["outcome"] for r in rows
                                 if r["outcome"] in ("PROVIDER_UNAVAILABLE", "TIMEOUT", "SPLEX_ERROR"))),
    }


def latency_stats(rows: list[dict]) -> dict:
    lat = sorted(r["latency_ms"] for r in rows
                 if r.get("latency_ms") and r["outcome"] not in ("TIMEOUT",))
    ttft = sorted(r["ttft_ms"] for r in rows if r.get("ttft_ms"))
    if not lat:
        return {"n": 0, "score": None}

    def pct(xs, p):
        return xs[min(len(xs) - 1, int(len(xs) * p))]

    p50 = pct(lat, 0.50)
    score = 0
    for threshold, s in LATENCY_BANDS:
        if p50 <= threshold:
            score = s
            break
    return {
        "n": len(lat), "p50_ms": p50, "p90_ms": pct(lat, 0.90), "max_ms": lat[-1],
        "ttft_p50_ms": pct(ttft, 0.50) if ttft else None,
        "score": score,
    }


def safety_isolation(db_models: list[str]) -> dict:
    """Every model the run ACTUALLY used, read from the database, must be an
    audited free id. This is the verification behind the free/paid isolation
    claim — the SSE stream never names a model, so an assertion made from the
    stream alone would be unfalsifiable."""
    seen = sorted(set(m for m in db_models if m))
    violations = [m for m in seen if m not in DISTINCT_FREE_MODEL_IDS]
    return {
        "distinct_models_used": seen,
        "violations": violations,
        "pct": 100.0 if not violations and seen else (0.0 if violations else None),
    }


def cost_efficiency(db: dict, or_usage_delta_usd: float | None) -> dict:
    """Charge correctness, measured from the rows SPLEX actually wrote.

    AMENDMENT to SPEC §3.2, logged in SIB-v1.0-SPEC.md §8: the spec asked for
    credits-charged vs. a re-computed `computeRealCost()`. That is not
    reproducible from outside the server — `messages` stores the resulting
    credit charge but not the input/output token counts the calculation
    consumed, so an external re-computation would have to invent its inputs.

    What is measured instead is the property that actually protects a user,
    and it is measured exactly rather than approximately:

      - a FAILED generation must cost the user nothing;
      - a COMPLETE generation must be charged something (silent free service
        is an accounting bug in the other direction);
      - real provider spend for a Free-tier run must be $0, since every
        routed model is a `:free` model.

    The narrower scope is stated in the report rather than presented as if
    the original definition had been met.
    """
    msgs = [m for m in db.get("messages", []) if m.get("role") == "assistant"]
    if not msgs:
        return {"n": 0, "pct": None}

    charged_on_failure, unbilled_success, ok = [], [], 0
    for m in msgs:
        credits = m.get("credits_charged") or 0
        status = m.get("status")
        if status == "failed":
            if credits > 0:
                charged_on_failure.append({"id": m["id"], "credits": credits})
            else:
                ok += 1
        elif status in ("complete", "completed"):
            if credits <= 0:
                unbilled_success.append(m["id"])
            else:
                ok += 1
        else:
            ok += 1     # streaming/unknown: not a charge error

    return {
        "n": len(msgs),
        "correctly_charged": ok,
        "pct": ok / len(msgs) * 100,
        "charged_for_failed_generation": charged_on_failure,
        "completed_but_unbilled": unbilled_success,
        "total_credits_charged": db.get("credits_total"),
        "real_provider_spend_usd": or_usage_delta_usd,
    }


def band_score(p50_ms: int) -> int:
    for threshold, s in LATENCY_BANDS:
        if p50_ms <= threshold:
            return s
    return 0


def overall(components: dict[str, float | None]) -> tuple[float, float]:
    """Weighted mean over components that produced a number.

    Renormalises over scored components so an unmeasurable one is excluded
    rather than counted as zero — a measurement gap is not a failure.
    """
    num = den = 0.0
    for name, weight in WEIGHTS.items():
        v = components.get(name)
        if v is None:
            continue
        num += v * weight
        den += weight
    return (num / den if den else 0.0), den
