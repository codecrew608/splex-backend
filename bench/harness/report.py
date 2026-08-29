"""Aggregates results into the accuracy / availability split.

The separation is structural, not a reporting convention: `accuracy` divides
only by answers that were actually generated, and `availability` is computed
from a different denominator entirely. There is no code path that lets a
provider failure reduce the accuracy score.
"""

from __future__ import annotations

from collections import defaultdict

from .evaluate import (
    ACCURACY_OUTCOMES, AVAILABILITY_FAILURES, CORRECT, INCORRECT, PARTIAL,
    UNSAFE_REFUSAL_MISMATCH, PROVIDER_UNAVAILABLE, TIMEOUT, SPLEX_ERROR,
    SKIPPED_CAPABILITY, BENCHMARK_ERROR, NEEDS_REVIEW,
)

ALL_OUTCOMES = [
    CORRECT, INCORRECT, PARTIAL, UNSAFE_REFUSAL_MISMATCH,
    PROVIDER_UNAVAILABLE, TIMEOUT, SPLEX_ERROR, SKIPPED_CAPABILITY,
    BENCHMARK_ERROR, NEEDS_REVIEW,
]


def _bucket(rows: list[dict]) -> dict:
    counts = {o: 0 for o in ALL_OUTCOMES}
    credit = 0.0
    for r in rows:
        o = r["outcome"]
        counts[o] = counts.get(o, 0) + 1
        if o == CORRECT:
            credit += 1.0
        elif o == PARTIAL:
            credit += float(r.get("partial") or 0.5)

    scored = sum(counts[o] for o in ACCURACY_OUTCOMES)
    attempted = len(rows)
    # "Attempted for availability" excludes questions we never tried because
    # the capability genuinely does not exist on the Free tier — counting
    # those as unavailability would blame the provider for a product gap.
    availability_denom = attempted - counts[SKIPPED_CAPABILITY] - counts[BENCHMARK_ERROR]

    return {
        "attempted": attempted,
        "counts": {k: v for k, v in counts.items() if v},
        # ACCURACY: denominator is answers actually generated.
        "accuracy_scored": scored,
        "accuracy_credit": round(credit, 2),
        "accuracy_pct": round(100 * credit / scored, 1) if scored else None,
        # AVAILABILITY: denominator is requests we genuinely attempted.
        "availability_answered": scored + counts[NEEDS_REVIEW],
        "availability_denom": availability_denom,
        "availability_pct": (
            round(100 * (scored + counts[NEEDS_REVIEW]) / availability_denom, 1)
            if availability_denom else None
        ),
        "provider_unavailable": counts[PROVIDER_UNAVAILABLE],
        "timeouts": counts[TIMEOUT],
        "splex_errors": counts[SPLEX_ERROR],
        "skipped_capability": counts[SKIPPED_CAPABILITY],
        "needs_review": counts[NEEDS_REVIEW],
    }


def build(results: list[dict]) -> dict:
    """Full report. `results` are Result dicts from the runner."""
    def group(key: str) -> dict:
        out: dict[str, list[dict]] = defaultdict(list)
        for r in results:
            out[str(r.get(key) or "unknown")].append(r)
        return {k: _bucket(v) for k, v in sorted(out.items())}

    paid_attempts = [r for r in results if r.get("paid_model_attempted")]

    return {
        "overall": _bucket(results),
        "by_category": group("category"),
        "by_difficulty": group("difficulty"),
        "by_model": group("routed_model"),
        "by_expected_capability": group("expected_capability"),
        "by_evaluation_method": group("evaluation_method"),
        "fallback": {
            "requests_with_fallback": sum(1 for r in results if r.get("used_fallback")),
            "total_candidates_attempted": sum(int(r.get("candidates_attempted") or 0) for r in results),
        },
        "routing": _routing(results),
        "safety": {
            "paid_models_attempted": len(paid_attempts),
            "paid_models_completed": sum(1 for r in paid_attempts if r.get("outcome") == CORRECT),
            "free_calls": sum(1 for r in results if r.get("routed_model")),
            "credits_charged_total": round(
                sum(float(r.get("credits_charged") or 0) for r in results), 4),
        },
    }


def _routing(results: list[dict]) -> dict:
    """Routing correctness, scored INDEPENDENTLY of answer correctness.

    A question can be routed perfectly and answered wrongly, or routed badly
    and answered right by luck. Conflating them hides both.
    """
    checked = [r for r in results if r.get("routed_category") and r.get("expected_capability")]
    matches = [r for r in checked if r["routed_category"] == r["expected_capability"]]
    mismatches = [
        {"question_id": r["question_id"], "expected": r["expected_capability"],
         "actual": r["routed_category"]}
        for r in checked if r["routed_category"] != r["expected_capability"]
    ]
    return {
        "checked": len(checked),
        "matched": len(matches),
        "routing_accuracy_pct": round(100 * len(matches) / len(checked), 1) if checked else None,
        "mismatches": mismatches[:40],
    }


def render(report: dict) -> str:
    o = report["overall"]
    lines = [
        "=" * 62,
        "ACCURACY (denominator = answers actually generated)",
        f"  {o['accuracy_credit']}/{o['accuracy_scored']} = "
        f"{o['accuracy_pct'] if o['accuracy_pct'] is not None else 'n/a'}%",
        "",
        "AVAILABILITY (denominator = requests genuinely attempted)",
        f"  {o['availability_answered']}/{o['availability_denom']} = "
        f"{o['availability_pct'] if o['availability_pct'] is not None else 'n/a'}%",
        "",
        f"  provider unavailable : {o['provider_unavailable']}",
        f"  timeouts             : {o['timeouts']}",
        f"  SPLEX errors         : {o['splex_errors']}",
        f"  skipped (capability) : {o['skipped_capability']}",
        f"  needs human review   : {o['needs_review']}",
        "",
        f"PAID MODELS ATTEMPTED : {report['safety']['paid_models_attempted']}",
        "=" * 62,
    ]
    return "\n".join(lines)
