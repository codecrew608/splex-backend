"""Tests for the SIB v1.0 notation normalisation.

Two properties matter, and the second matters more:
  1. Equivalent notations for a RIGHT answer now score correct.
  2. A WRONG answer is still wrong after normalisation.

(2) is what separates a normalisation fix from quietly inflating the score.
Every case below that must stay INCORRECT is there to prove the rules cannot
turn a wrong answer into a right one.
"""

from __future__ import annotations

import sys

from .evaluate import score, normalise_notation, CORRECT, INCORRECT

SYMBOLIC = {"evaluation_method": "SYMBOLIC", "gold_answer": "x**2 - 9"}
EXACT_BIGO = {"evaluation_method": "EXACT", "gold_answer": "O(n^2)"}
NUMERIC_23 = {"evaluation_method": "NUMERIC", "gold_answer": 0.6666666667, "tolerance": 0.001}

MUST_PASS = [
    ("unicode superscript", EXACT_BIGO, "O(n²)"),
    ("plain ascii still fine", EXACT_BIGO, "The complexity is O(n^2)."),
    ("latex display maths", SYMBOLIC, "$$(x + 3)(x - 3) = x^2 - 9$$"),
    ("latex inline maths", SYMBOLIC, r"the result is \(x^2 - 9\)"),
    ("latex frac", NUMERIC_23, r"$\frac{2}{3}$"),
    ("unicode division sign", NUMERIC_23, "1÷1.5 = 0.6667"),
]

MUST_FAIL = [
    ("wrong exponent stays wrong", EXACT_BIGO, "O(n³)"),
    ("wrong polynomial stays wrong", SYMBOLIC, "$$x^2 - 4$$"),
    ("wrong fraction stays wrong", NUMERIC_23, r"$\frac{3}{4}$"),
    ("unrelated prose stays wrong", SYMBOLIC, "I am not sure about this one."),
]


def main() -> int:
    failures = 0

    print("== equivalent notation must now score CORRECT ==")
    for label, q, resp in MUST_PASS:
        s = score(q, resp)
        ok = s.outcome == CORRECT
        print(f"  {'PASS' if ok else 'FAIL'}  {label:<28} -> {s.outcome} ({s.detail[:50]})")
        failures += 0 if ok else 1

    print("\n== a wrong answer must STAY wrong (no score inflation) ==")
    for label, q, resp in MUST_FAIL:
        s = score(q, resp)
        ok = s.outcome == INCORRECT
        print(f"  {'PASS' if ok else 'FAIL'}  {label:<28} -> {s.outcome}")
        failures += 0 if ok else 1

    print("\n== normalisation must not touch structural judgement ==")
    # A STRUCTURE item is judged on the raw string; prove the raw text is
    # what reaches it by checking a constraint normalisation would break.
    s = score({"evaluation_method": "STRUCTURE", "rubric": ["no dollar sign"]}, "$$x$$")
    ok = s.outcome == INCORRECT
    print(f"  {'PASS' if ok else 'FAIL'}  dollar signs still detected -> {s.outcome}")
    failures += 0 if ok else 1

    print("\n" + ("ALL NORMALISATION CHECKS PASSED" if not failures else f"{failures} FAILURES"))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())


# --- SFB v1.0 additions -----------------------------------------------------
# Scientific notation written longhand, and diacritics. Same rule as every
# other normalisation here: a right answer written differently must pass, and
# a WRONG answer must stay wrong.

SCI = {"evaluation_method": "NUMERIC", "gold_answer": 1.75e-07, "tolerance": 1.75e-13}
CITY = {"evaluation_method": "EXACT", "gold_answer": "brasilia"}

SFB_MUST_PASS = [
    ("latex sci notation", SCI, "$$\n1.75 \\times 10^{-7}\n$$"),
    ("plain sci notation", SCI, "1.75 x 10^-7"),
    ("e notation still fine", SCI, "1.75e-7"),
    ("diacritics stripped", CITY, "Brasília"),
    ("plain spelling still fine", CITY, "The capital is Brasilia."),
]

SFB_MUST_FAIL = [
    ("wrong mantissa stays wrong", SCI, "2.75 \\times 10^{-7}"),
    ("wrong exponent stays wrong", SCI, "1.75 \\times 10^{-9}"),
    ("different city stays wrong", CITY, "Brasões"),
    ("unrelated city stays wrong", CITY, "Buenos Aires"),
]


def sfb_main() -> int:
    failures = 0
    print("\n== SFB v1.0: scientific notation and diacritics ==")
    for label, q, resp in SFB_MUST_PASS:
        s = score(q, resp)
        ok = s.outcome == CORRECT
        print(f"  {'PASS' if ok else 'FAIL'}  {label:<28} -> {s.outcome}")
        failures += 0 if ok else 1
    print("\n== and wrong answers must STILL be wrong ==")
    for label, q, resp in SFB_MUST_FAIL:
        s = score(q, resp)
        ok = s.outcome == INCORRECT
        print(f"  {'PASS' if ok else 'FAIL'}  {label:<28} -> {s.outcome}")
        failures += 0 if ok else 1
    print("\n" + ("SFB NORMALISATION CHECKS PASSED" if not failures else f"{failures} FAILURES"))
    return 1 if failures else 0
