"""Builds, validates and de-duplicates the corpus into corpus.jsonl.

Refuses to emit anything unless every check passes. A corpus that builds with
known-bad records produces confidently wrong scores later, which is worse than
no corpus at all.

Run:  python3 -m bench.corpus.build
"""

from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

from .schema import Question, validate, exact_key, skeleton_key, token_set, jaccard, CorpusError
from .generators import (mathematics, physics, coding, reasoning, capability,
                         knowledge, extended_math, physics_extended)
from .generators.coding_reference import REFERENCE_SOLUTIONS

OUT = Path(__file__).parent / "corpus.jsonl"
NEAR_DUPLICATE_THRESHOLD = 0.92


def collect() -> list[Question]:
    qs: list[Question] = []
    for mod in (mathematics, physics, coding, reasoning, capability, knowledge,
                extended_math, physics_extended):
        qs.extend(mod.all_questions())
    return qs


def check_unique_ids(qs: list[Question]) -> list[str]:
    dupes = [qid for qid, n in Counter(q.question_id for q in qs).items() if n > 1]
    return [f"duplicate question_id: {d}" for d in dupes]


def find_duplicates(qs: list[Question]) -> tuple[list[str], int]:
    """Exact and near-duplicate detection.

    Skeleton collisions (same text, different numbers) are reported but NOT
    treated as fatal: a numeric change can be the whole point of the question
    (0 vs negative vs boundary). Those are counted and surfaced so a human can
    audit them, rather than silently dropped.
    """
    problems: list[str] = []
    seen_exact: dict[str, str] = {}
    for q in qs:
        k = exact_key(q.prompt)
        if k in seen_exact:
            problems.append(f"EXACT duplicate prompt: {q.question_id} == {seen_exact[k]}")
        else:
            seen_exact[k] = q.question_id

    # Near-duplicates, compared only within a subcategory: cross-domain token
    # overlap is meaningless, and all-pairs over the whole corpus is quadratic
    # for no benefit.
    by_bucket: dict[str, list[Question]] = defaultdict(list)
    for q in qs:
        by_bucket[f"{q.category}/{q.subcategory}"].append(q)

    for bucket, group in by_bucket.items():
        toks = [(q, token_set(q.prompt)) for q in group]
        for i in range(len(toks)):
            for j in range(i + 1, len(toks)):
                a, b = toks[i][0], toks[j][0]
                sim = jaccard(toks[i][1], toks[j][1])
                if sim < NEAR_DUPLICATE_THRESHOLD:
                    continue
                # A declared minimal pair is the experiment, not an accident:
                # two prompts differing by one decisive word probe opposite
                # behaviours. Declaring it (either direction) exempts the pair.
                if a.minimal_pair_of == b.question_id or b.minimal_pair_of == a.question_id:
                    continue
                problems.append(
                    f"NEAR duplicate ({sim:.2f}) in {bucket}: "
                    f"{a.question_id} ~ {b.question_id} "
                    f"(if deliberate, set minimal_pair_of and explain in notes)"
                )

    skeleton_collisions = sum(
        n - 1 for n in Counter(skeleton_key(q.prompt) for q in qs).values() if n > 1
    )
    return problems, skeleton_collisions


def verify_programmatic(qs: list[Question]) -> list[str]:
    """Every PROGRAMMATIC question's hidden tests must be provably satisfiable.

    Without this, a typo in a test silently marks correct answers wrong.
    """
    sys.path.insert(0, str(Path(__file__).parent.parent.parent))
    from bench.harness.sandbox import run_hidden_tests

    problems = []
    for q in qs:
        if q.evaluation_method != "PROGRAMMATIC":
            continue
        ref = REFERENCE_SOLUTIONS.get(q.question_id)
        if not ref:
            problems.append(f"{q.question_id}: PROGRAMMATIC with no reference solution to verify tests")
            continue
        r = run_hidden_tests(ref, q.hidden_tests)
        if not r.passed:
            problems.append(f"{q.question_id}: hidden tests REJECT the reference solution ({r.error})")
    return problems


def summarise(qs: list[Question]) -> dict:
    groups = {q.group_id for q in qs}
    return {
        "total_groups": len(groups),
        "total_questions": len(qs),
        "by_domain": dict(sorted(Counter(q.category for q in qs).items())),
        "by_difficulty": dict(sorted(Counter(q.difficulty for q in qs).items())),
        "by_eval_method": dict(sorted(Counter(q.evaluation_method for q in qs).items())),
        "by_expected_capability": dict(sorted(Counter(q.expected_capability for q in qs).items())),
        "by_question_type": dict(sorted(Counter(q.question_type for q in qs).items())),
        "adversarial_items": sum(1 for q in qs if q.adversarial_level > 0),
        "programmatically_verifiable": sum(
            1 for q in qs if q.evaluation_method in ("PROGRAMMATIC", "NUMERIC", "SYMBOLIC", "EXACT")
        ),
        "gold_answer_items": sum(1 for q in qs if q.gold_answer is not None),
        "rubric_items": sum(1 for q in qs if q.rubric),
        "refusal_expected_items": sum(1 for q in qs if q.evaluation_method == "REFUSAL"),
        "declared_minimal_pairs": sum(1 for q in qs if q.minimal_pair_of),
        "no_answer_key_by_design": sum(
            1 for q in qs if q.gold_answer is None and not q.rubric and not q.reference_facts
        ),
    }


def main() -> int:
    qs = collect()
    problems: list[str] = []

    for q in qs:
        try:
            validate(q)
        except CorpusError as e:
            problems.append(str(e))

    problems += check_unique_ids(qs)
    dup_problems, skeleton_collisions = find_duplicates(qs)
    problems += dup_problems
    problems += verify_programmatic(qs)

    if problems:
        print(f"CORPUS BUILD FAILED — {len(problems)} problem(s):\n", file=sys.stderr)
        for p in problems[:60]:
            print(f"  - {p}", file=sys.stderr)
        if len(problems) > 60:
            print(f"  ... and {len(problems) - 60} more", file=sys.stderr)
        return 1

    with OUT.open("w") as fh:
        for q in sorted(qs, key=lambda x: x.question_id):
            fh.write(json.dumps(q.to_json(), sort_keys=True) + "\n")

    s = summarise(qs)
    s["skeleton_collisions_reviewed"] = skeleton_collisions
    print(json.dumps(s, indent=2))
    print(f"\nwrote {OUT} ({len(qs)} questions)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
