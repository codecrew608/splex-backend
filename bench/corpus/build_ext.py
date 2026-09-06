"""Builds and validates bench/corpus/sib_ext.jsonl.

Kept separate from build.py so the inherited corpus file is never rewritten
by this session's work — the two sets stay independently auditable, and a bug
here cannot corrupt 404 previously-validated items.
"""

from __future__ import annotations

import json
from pathlib import Path

from .generators import sib_ext
from .schema import CorpusError, validate

OUT = Path(__file__).parent / "sib_ext.jsonl"


def main() -> int:
    questions = sib_ext.build()

    problems: list[str] = []
    seen_ids: set[str] = set()
    for q in questions:
        try:
            validate(q)   # raises on the first problem with this record
        except CorpusError as e:
            problems.append(str(e))
        if q.question_id in seen_ids:
            problems.append(f"duplicate question_id {q.question_id}")
        seen_ids.add(q.question_id)

    rows = [q.to_json() for q in questions]

    # An unscoreable item is worse than a missing one: it silently shrinks a
    # denominator at run time instead of failing loudly here.
    for r in rows:
        if r["evaluation_method"] == "NUMERIC" and r.get("gold_answer") is None:
            problems.append(f"{r['question_id']}: NUMERIC with no gold_answer")
        if r["evaluation_method"] == "EXACT" and not r.get("gold_answer"):
            problems.append(f"{r['question_id']}: EXACT with no gold_answer")
        if r["evaluation_method"] == "STRUCTURE" and not r.get("rubric"):
            problems.append(f"{r['question_id']}: STRUCTURE with no criteria")
        if len(r["prompt"]) > 8000:
            problems.append(f"{r['question_id']}: prompt exceeds the API's 8000-char cap")

    if problems:
        print("REFUSING to write an invalid extension corpus:")
        for p in problems:
            print(f"  {p}")
        return 1

    OUT.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n")
    by_cat: dict[str, int] = {}
    for r in rows:
        by_cat[r["category"]] = by_cat.get(r["category"], 0) + 1
    print(f"wrote {OUT} — {len(rows)} items")
    for c, n in sorted(by_cat.items()):
        print(f"  {c:<24} {n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
