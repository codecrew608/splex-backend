"""Tests for the SIB v1.0 additions to score_structure.

A scorer bug here does not produce an obvious crash — it produces a wrong
benchmark number, which is worse. Each case pins one criterion against a
string that must pass and a string that must fail.
"""

from __future__ import annotations

import sys

from .evaluate import score_structure, CORRECT, INCORRECT, NEEDS_REVIEW

CASES: list[tuple[str, list[str], str, str]] = [
    # (label, criteria, must_pass, must_fail)
    ("exactly N words", ["exactly 1 word"], "Tokyo", "Tokyo Japan"),
    ("exactly N words (5)", ["exactly 5 words"], "vast salty deep restless blue", "too short"),
    ("at most N words", ["at most 12 words"], "mass attracts mass", " ".join(["w"] * 13)),
    ("exactly N lines", ["exactly 2 lines"], "one\ntwo", "one\ntwo\nthree"),
    ("starts with", ["starts with 'Rain'"], "Rain falls softly", "The rain falls"),
    ("ends with", ["ends with 'river'"], "The Danube is a river", "river of Danube"),
    ("does not contain", ["does not contain 'blue'"], "green grass", "blue sky"),
    ("no digits", ["no digits"], "many crates", "7 crates"),
    ("all uppercase", ["all uppercase"], "ACKNOWLEDGED", "Acknowledged"),
    ("valid json", ["valid json"], '{"answer": 7}', "answer is 7"),
    ("valid json in fence", ["valid json"], '```json\n{"answer": 7}\n```', "```\nnot json\n```"),
    ("no letter e", ["no letter 'e'"], "grass is m0ss", "green"),
    ("no trailing period", ["no trailing period"], "Tokyo", "Tokyo."),
]

MULTI = [
    ("all constraints met",
     ["exactly 1 word", "all uppercase"], "ACKNOWLEDGED", CORRECT),
    ("one of two constraints fails",
     ["exactly 1 word", "all uppercase"], "Acknowledged", INCORRECT),
]


def main() -> int:
    failures = 0

    print("== single criteria ==")
    for label, criteria, good, bad in CASES:
        g = score_structure(good, criteria)
        b = score_structure(bad, criteria)
        ok = g.outcome == CORRECT and b.outcome == INCORRECT
        print(f"  {'PASS' if ok else 'FAIL'}  {label:<22} good={g.outcome:<10} bad={b.outcome}")
        if not ok:
            failures += 1

    print("\n== combined criteria ==")
    for label, criteria, text, expected in MULTI:
        s = score_structure(text, criteria)
        ok = s.outcome == expected
        print(f"  {'PASS' if ok else 'FAIL'}  {label:<30} -> {s.outcome}")
        if not ok:
            failures += 1

    print("\n== an unrecognised criterion must go to review, never be assumed met ==")
    s = score_structure("anything", ["written in an elegant tone"])
    ok = s.outcome == NEEDS_REVIEW
    print(f"  {'PASS' if ok else 'FAIL'}  unknown criterion -> {s.outcome}")
    if not ok:
        failures += 1

    print("\n" + ("ALL STRUCTURE CHECKS PASSED" if not failures else f"{failures} FAILURES"))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
