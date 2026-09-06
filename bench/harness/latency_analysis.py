"""Attributes measured latency to its causes, from data already collected.

No new requests. It joins two artefacts of the SIB v1.0 run:

  - the per-item routing simulation (whether each message resolved from
    keywords or had to pay for the LLM classifier), and
  - the per-item time-to-first-token and total latency actually observed.

The classifier round-trip happens BEFORE generation starts, so if it costs
what it appears to cost, it should show up as a difference in time-to-first-
token between the two groups and NOT as a difference in generation time.
That distinction is testable, so the script tests it rather than asserting
it, and reports a Mann-Whitney-style rank comparison alongside the medians
because the samples are small and skewed.
"""

from __future__ import annotations

import argparse
import json
import statistics
from pathlib import Path


def median(xs: list[float]) -> float | None:
    return statistics.median(xs) if xs else None


def rank_sum_p(a: list[float], b: list[float]) -> tuple[float, str]:
    """Mann-Whitney U with a normal approximation.

    Small, skewed samples make a t-test's assumptions wrong; ranks make no
    distributional assumption. The normal approximation is fine at these n
    and its limitation is reported rather than hidden.
    """
    if len(a) < 3 or len(b) < 3:
        return (float("nan"), "n too small for a rank test")
    combined = sorted([(v, 0) for v in a] + [(v, 1) for v in b])
    ranks: dict[int, float] = {0: 0.0, 1: 0.0}
    i = 0
    while i < len(combined):
        j = i
        while j + 1 < len(combined) and combined[j + 1][0] == combined[i][0]:
            j += 1
        avg_rank = (i + j) / 2 + 1
        for k in range(i, j + 1):
            ranks[combined[k][1]] += avg_rank
        i = j + 1
    n1, n2 = len(a), len(b)
    u1 = ranks[0] - n1 * (n1 + 1) / 2
    mu = n1 * n2 / 2
    sigma = (n1 * n2 * (n1 + n2 + 1) / 12) ** 0.5
    if sigma == 0:
        return (float("nan"), "degenerate")
    z = (u1 - mu) / sigma
    # two-sided normal tail
    p = 2 * (1 - 0.5 * (1 + _erf(abs(z) / (2 ** 0.5))))
    return (p, f"U={u1:.0f} z={z:.2f}")


def _erf(x: float) -> float:
    # Abramowitz & Stegun 7.1.26 — plenty accurate for a reported p-value.
    a1, a2, a3, a4, a5, p = 0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429, 0.3275911
    sign = 1 if x >= 0 else -1
    x = abs(x)
    t = 1.0 / (1.0 + p * x)
    y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * pow(2.718281828459045, -x * x)
    return sign * y


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", required=True, help="SIB results JSONL")
    ap.add_argument("--route-sim", required=True, help="per-item routing simulation JSONL")
    ap.add_argument("--target", default="splex")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    rows = [json.loads(l) for l in Path(args.results).read_text().splitlines() if l.strip()]
    rows = [r for r in rows if r["target"] == args.target]
    sim = {json.loads(l)["question_id"]: json.loads(l)
           for l in Path(args.route_sim).read_text().splitlines() if l.strip()}

    fb_ttft, det_ttft, fb_total, det_total = [], [], [], []
    gen_fb, gen_det = [], []
    for r in rows:
        if r["outcome"] in ("PROVIDER_UNAVAILABLE", "TIMEOUT", "SPLEX_ERROR"):
            continue
        s = sim.get(r["question_id"])
        if not s or r.get("ttft_ms") is None:
            continue
        fallback = s["via"] == "llm_fallback"
        (fb_ttft if fallback else det_ttft).append(r["ttft_ms"])
        if r.get("latency_ms"):
            (fb_total if fallback else det_total).append(r["latency_ms"])
            # Generation time = everything after the first token. If the
            # classifier is the cause, this should NOT differ between groups.
            (gen_fb if fallback else gen_det).append(r["latency_ms"] - r["ttft_ms"])

    p_ttft, detail_ttft = rank_sum_p(fb_ttft, det_ttft)
    p_gen, detail_gen = rank_sum_p(gen_fb, gen_det)

    report = {
        "n_llm_fallback": len(fb_ttft),
        "n_deterministic": len(det_ttft),
        "ttft_median_fallback_ms": median(fb_ttft),
        "ttft_median_deterministic_ms": median(det_ttft),
        "ttft_delta_ms": (median(fb_ttft) - median(det_ttft))
        if fb_ttft and det_ttft else None,
        "total_median_fallback_ms": median(fb_total),
        "total_median_deterministic_ms": median(det_total),
        "generation_median_fallback_ms": median(gen_fb),
        "generation_median_deterministic_ms": median(gen_det),
        "ttft_rank_test": {"p": p_ttft, "detail": detail_ttft},
        "generation_rank_test": {"p": p_gen, "detail": detail_gen},
    }

    print("classifier round-trip, measured from the SIB v1.0 run")
    print(f"  items that paid for the LLM classifier : {report['n_llm_fallback']}")
    print(f"  items resolved from keywords           : {report['n_deterministic']}")
    print()
    print(f"  median TTFT, classifier path   : {report['ttft_median_fallback_ms']} ms")
    print(f"  median TTFT, keyword path      : {report['ttft_median_deterministic_ms']} ms")
    print(f"  difference                     : {report['ttft_delta_ms']} ms   "
          f"(rank test p={p_ttft:.4f}, {detail_ttft})")
    print()
    print(f"  median GENERATION time, classifier path : {report['generation_median_fallback_ms']} ms")
    print(f"  median GENERATION time, keyword path    : {report['generation_median_deterministic_ms']} ms")
    print(f"  difference should be ~noise if the classifier is the cause "
          f"(rank test p={p_gen:.4f})")

    if args.out:
        Path(args.out).write_text(json.dumps(report, indent=2))
        print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
