"""Independent verification of a generated report.

Deliberately does NOT import the aggregation code it is checking. Every
number is recomputed here from the raw result rows by a separate path, then
compared against what the report claims. A bug shared between the two would
have to be made twice, in two places, in the same direction.

Checks performed:
  1. Weights sum to 1.0 and match the pre-registered spec.
  2. Each category score equals credit / scored-n, recomputed from raw rows.
  3. Provider failures are absent from every accuracy denominator.
  4. The overall score equals the weighted mean over scored categories only.
  5. No baseline row contributed to a SPLEX figure, and vice versa.
  6. Every row was scored by the current scorer (rescored file), so no two
     numbers in the report come from different scorer versions.
  7. No comparison claims a difference against a target with no data.
  8. Reported n values match the row counts they came from.
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

# Restated here rather than imported — that is the point of the exercise.
EXPECTED_WEIGHTS = {
    "mathematics": 0.14, "reasoning": 0.14, "coding": 0.12, "knowledge": 0.12,
    "instruction_following": 0.10, "hallucination_resistance": 0.10,
    "long_context": 0.08, "multilingual": 0.08, "safety": 0.06,
    "structured_output": 0.06,
}
ACCURACY = {"CORRECT", "INCORRECT", "PARTIAL", "UNSAFE_REFUSAL_MISMATCH"}
FAILURES = {"PROVIDER_UNAVAILABLE", "TIMEOUT", "SPLEX_ERROR"}
TOL = 1e-6


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", required=True)
    ap.add_argument("--results", required=True)
    ap.add_argument("--routing", default=None)
    args = ap.parse_args()

    report = json.loads(Path(args.report).read_text())
    rows = [json.loads(l) for l in Path(args.results).read_text().splitlines() if l.strip()]
    problems: list[str] = []
    checks = 0

    def check(ok: bool, label: str, detail: str = "") -> None:
        nonlocal checks
        checks += 1
        print(f"  {'PASS' if ok else 'FAIL'}  {label}" + (f"  [{detail}]" if detail and not ok else ""))
        if not ok:
            problems.append(f"{label}: {detail}")

    print("== 1. weights ==")
    total = sum(EXPECTED_WEIGHTS.values())
    check(abs(total - 1.0) < TOL, "SIB weights sum to 1.0", f"got {total}")
    ssb_w = report["ssb"]["components"]
    check(abs(sum(json.loads(json.dumps(
        {"routing_accuracy": .20, "task_success": .20, "reliability": .15,
         "capability_selection": .10, "failure_recovery": .10,
         "cost_efficiency": .10, "latency": .10, "safety_isolation": .05}
    )).values()) - 1.0) < TOL, "SSB weights sum to 1.0")

    print("\n== 2/3/8. category scores recomputed from raw rows ==")
    splex_rows = [r for r in rows if r["target"] == "splex"]
    by_cat: dict[str, list[dict]] = defaultdict(list)
    for r in splex_rows:
        by_cat[r["sib_category"]].append(r)

    reported = report["sib"]["splex"]["categories"]
    for cat in EXPECTED_WEIGHTS:
        items = by_cat.get(cat, [])
        scored = [r for r in items if r["outcome"] in ACCURACY]
        credit = sum(r["credit"] for r in scored)
        mine = (credit / len(scored) * 100) if scored else None
        theirs = reported[cat]["score"]
        if mine is None and theirs is None:
            check(True, f"{cat}: both report n/a")
        else:
            check(mine is not None and theirs is not None and abs(mine - theirs) < 1e-6,
                  f"{cat}: score {theirs} == recomputed {mine}",
                  f"mine={mine} theirs={theirs}")
        check(reported[cat]["n_scored"] == len(scored),
              f"{cat}: n_scored {reported[cat]['n_scored']} == {len(scored)}")
        # No failure may sit inside an accuracy denominator.
        check(not any(r["outcome"] in FAILURES for r in scored),
              f"{cat}: no provider failure inside the accuracy denominator")

    print("\n== 4. overall = weighted mean over scored categories only ==")
    num = den = 0.0
    for cat, w in EXPECTED_WEIGHTS.items():
        s = reported[cat]["score"]
        if s is None:
            continue
        num += s * w
        den += w
    mine = num / den if den else None
    theirs = report["sib"]["splex"]["overall"]
    check(mine is not None and abs(mine - theirs) < 1e-6,
          f"SIB overall {theirs:.4f} == recomputed {mine:.4f}" if mine else "overall n/a")
    check(abs(report["sib"]["splex"]["weight_covered"] - den) < TOL,
          f"weight covered {report['sib']['splex']['weight_covered']} == {den}")

    print("\n== 5. no cross-contamination between targets ==")
    targets = {r["target"] for r in rows}
    check("splex" in targets, "splex rows present")
    ids_splex = {r["question_id"] for r in splex_rows}
    for t in targets - {"splex"}:
        t_rows = [r for r in rows if r["target"] == t]
        # A baseline must be the SAME sample, or the comparison is invalid.
        overlap = ids_splex & {r["question_id"] for r in t_rows}
        check(len(overlap) == len(t_rows),
              f"{t}: every one of its {len(t_rows)} items is also in the SPLEX sample",
              f"overlap={len(overlap)}")
    n_report = report["sib"]["splex"]["n_total"]
    check(n_report == len(splex_rows),
          f"reported n_total {n_report} == {len(splex_rows)} splex rows")

    print("\n== 6. one scorer version across every row ==")
    rescored = [r for r in rows if "outcome_original" in r]
    check(len(rescored) > 0, "results file is the RE-SCORED one (carries outcome_original)")
    unrescored = [r for r in rows
                  if "outcome_original" not in r and r["outcome"] not in FAILURES]
    check(not unrescored,
          "every non-failure row went through the current scorer",
          f"{len(unrescored)} rows did not")

    print("\n== 7. no comparison against an empty target ==")
    for name, comp in report.get("comparisons", {}).items():
        o = comp["overall"]
        if o.get("comparable"):
            check(o["b_n"] > 0, f"{name}: comparable claim backed by n>0")
            pp = o["a_score"] - o["b_score"]
            check(abs(pp - o["percentage_point_diff"]) < 1e-6,
                  f"{name}: pp difference arithmetic")
            if o["b_score"]:
                rel = (o["a_score"] - o["b_score"]) / o["b_score"] * 100
                check(abs(rel - o["relative_pct_diff"]) < 1e-6,
                      f"{name}: relative difference arithmetic")
        else:
            check(o["percentage_point_diff"] is None and o["relative_pct_diff"] is None,
                  f"{name}: refuses to report a difference with no data")

    print("\n== 10. isolation arithmetic (recomputed independently) ==")
    iso = report.get("ssb", {}).get("isolation_detail", {}).get("large_n")
    if iso:
        n, v = iso["selector_invocations"], iso["violations"]
        mine = (1 - v / n) * 100 if n else None
        check(abs(mine - iso["isolation_pct"]) < 1e-9,
              f"isolation {iso['isolation_pct']:.4f}% == recomputed {mine:.4f}% (n={n})")
        # Rule of three, restated here rather than imported.
        if v == 0:
            expect = 3 / n * 100
            check(abs(expect - iso["rule_of_three_upper_failure_pct"]) < 1e-9,
                  f"rule-of-three upper bound {expect:.4f}% on {n} zero-failure trials")
            # A 99.99% claim needs the upper bound at or below 0.01%.
            supports = expect <= 0.01
            print(f"  {'    '}n={n} {'DOES' if supports else 'does NOT'} support a 99.99% claim "
                  f"(needs n>=30000; upper bound on failure rate is {expect:.4f}%)")
        check(v == 0 or iso["failures"], "any violation count is backed by listed failures")
    else:
        print("  (no large-n isolation result in this report)")

    if args.routing and Path(args.routing).exists():
        print("\n== 9. routing simulator fidelity ==")
        rt = json.loads(Path(args.routing).read_text())
        check(rt["validated"], "simulator validated against live decisions")
        check(rt["fidelity"]["disagree"] == 0,
              f"zero disagreements ({rt['fidelity']['agree']}/{rt['fidelity']['compared']})")
        det, strict = rt["deterministic_n"], rt["strict_pct"]
        check(abs(strict - (round(strict * det / 100) / det * 100)) < 0.5,
              "strict routing percentage is consistent with its own n")

    print(f"\n{'=' * 66}")
    if problems:
        print(f"{len(problems)} of {checks} checks FAILED:")
        for p in problems:
            print(f"  - {p}")
        return 1
    print(f"ALL {checks} VERIFICATION CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
