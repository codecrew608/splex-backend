"""Corpus composition report.

Read-only. Prints how corpus.jsonl breaks down by category, evaluation
method, difficulty and capability, so a sample can be stratified against the
real distribution rather than guessed at.
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

CORPUS = Path(__file__).parent.parent / "corpus" / "corpus.jsonl"


def load() -> list[dict]:
    return [json.loads(l) for l in CORPUS.read_text().splitlines() if l.strip()]


def table(title: str, counter: Counter, total: int) -> None:
    print(f"\n{title}  ({len(counter)} distinct)")
    for key, n in counter.most_common():
        print(f"  {str(key):<44} {n:>4}  {n / total * 100:5.1f}%")


def main() -> None:
    rows = load()
    total = len(rows)
    print(f"corpus.jsonl — {total} items")

    table("category", Counter(r["category"] for r in rows), total)
    table("evaluation_method", Counter(r["evaluation_method"] for r in rows), total)
    table("difficulty", Counter(r["difficulty"] for r in rows), total)
    table("expected_capability", Counter(r["expected_capability"] for r in rows), total)
    table("source", Counter(r.get("source", "?") for r in rows), total)

    auto = [r for r in rows if r["evaluation_method"] not in ("rubric", "manual_review")]
    print(f"\nauto-gradable: {len(auto)}/{total} ({len(auto) / total * 100:.1f}%)")

    print("\nfields present on a sample record:")
    print(json.dumps(rows[0], indent=2)[:900])


if __name__ == "__main__":
    main()
