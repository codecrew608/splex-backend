"""Validates the offline routing simulator against live decisions.

The simulator is only worth anything if it reproduces what the deployed
system actually did. This compares it, item by item, against every routing
decision recorded in the live run.

Items the simulator marks `llm_fallback` are excluded from the agreement
check but counted and reported: their real outcome depends on a model call,
so the simulator makes no claim about them and must not be credited or
blamed for them.

Any disagreement on a deterministic item is a fidelity bug and is printed in
full — the simulator's large-n routing figure is withheld unless agreement
on deterministic items is total.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

from .ssb import LABEL_TO_CATEGORY
from .sib import wilson_interval

ACCEPTABLE = {
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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sim", required=True)
    ap.add_argument("--live", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    sim = {json.loads(l)["question_id"]: json.loads(l)
           for l in Path(args.sim).read_text().splitlines() if l.strip()}
    live = [json.loads(l) for l in Path(args.live).read_text().splitlines() if l.strip()]
    live = [r for r in live if r["target"] == "splex" and r.get("routed_category")]

    agree = disagree = fallback = 0
    mismatches = []
    for r in live:
        s = sim.get(r["question_id"])
        if not s:
            continue
        if s["via"] == "llm_fallback":
            fallback += 1
            continue
        actual = LABEL_TO_CATEGORY.get(r["routed_category"])
        if actual == s["predicted_category"]:
            agree += 1
        else:
            disagree += 1
            mismatches.append({
                "question_id": r["question_id"], "sim": s["predicted_category"],
                "live": actual, "via": s["via"], "intent_id": s["intent_id"],
            })

    checked = agree + disagree
    print(f"fidelity check against the live run:")
    print(f"  deterministic items compared : {checked}")
    print(f"  agreements                   : {agree}")
    print(f"  disagreements                : {disagree}")
    print(f"  live items the simulator does not model (llm_fallback): {fallback}")
    for m in mismatches[:15]:
        print(f"    MISMATCH {m['question_id']}: sim={m['sim']} live={m['live']} via={m['via']}")

    valid = checked > 0 and disagree == 0
    print(f"\nsimulator {'VALIDATED' if valid else 'NOT VALIDATED'} "
          f"({agree}/{checked} exact agreement)")

    # Corpus-wide routing, reported only if the simulator earned it.
    rows = list(sim.values())
    det = [r for r in rows if r["via"] != "llm_fallback"]
    strict = sum(1 for r in det if r["predicted_category"] == r["expected_capability"])
    accept = sum(1 for r in det
                 if r["predicted_category"] in
                 ACCEPTABLE.get(r["expected_capability"], {r["expected_capability"]}))

    confusion = Counter(f"{r['expected_capability']} -> {r['predicted_category']}" for r in det)
    via = Counter(r["via"] for r in rows)

    result = {
        "validated": valid,
        "fidelity": {"compared": checked, "agree": agree, "disagree": disagree,
                     "mismatches": mismatches, "llm_fallback_in_live": fallback},
        "corpus_n": len(rows),
        "deterministic_n": len(det),
        "llm_fallback_n": via.get("llm_fallback", 0),
        "resolution_path": dict(via),
        "strict_pct": (strict / len(det) * 100) if det else None,
        "strict_ci": wilson_interval(strict, len(det)) if det else None,
        "acceptable_pct": (accept / len(det) * 100) if det else None,
        "acceptable_ci": wilson_interval(accept, len(det)) if det else None,
        "confusion": dict(confusion.most_common(20)),
    }
    Path(args.out).write_text(json.dumps(result, indent=2))

    if valid:
        print(f"\ncorpus-wide routing over {len(det)} deterministic items "
              f"(of {len(rows)}):")
        print(f"  strict     {result['strict_pct']:.1f}%  "
              f"95% CI [{result['strict_ci'][0]:.1f}, {result['strict_ci'][1]:.1f}]")
        print(f"  acceptable {result['acceptable_pct']:.1f}%  "
              f"95% CI [{result['acceptable_ci'][0]:.1f}, {result['acceptable_ci'][1]:.1f}]")
        print(f"  resolution path: {dict(via)}")
        print("  top confusions:")
        for k, v in list(confusion.most_common(10)):
            print(f"    {k:<34} {v}")
    print(f"\nwrote {args.out}")
    return 0 if valid else 1


if __name__ == "__main__":
    raise SystemExit(main())
