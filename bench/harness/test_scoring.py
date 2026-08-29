"""Tests the accuracy/availability separation and the free/paid invariant.

Run: python3 -m bench.harness.test_scoring

The single most important property here: no provider failure, of any shape,
can ever reduce the accuracy score. A benchmark that silently converts a 429
into a wrong answer reports a throttled provider as an incompetent one, and
every downstream conclusion drawn from it is wrong.
"""

from __future__ import annotations

import sys

from .evaluate import (
    score, classify_failure, CORRECT, INCORRECT, PROVIDER_UNAVAILABLE,
    TIMEOUT, SPLEX_ERROR, NEEDS_REVIEW, ACCURACY_OUTCOMES,
)
from .report import build

FAILURES: list[str] = []


def check(label: str, cond: bool) -> None:
    print(f"  {'PASS' if cond else 'FAIL'}  {label}")
    if not cond:
        FAILURES.append(label)


NUMERIC_Q = {"evaluation_method": "NUMERIC", "gold_answer": 42.0, "tolerance": 1e-6}


def main() -> int:
    print("\n== no provider failure can become an accuracy failure ==")
    provider_failures = [
        "HTTP 429", "Provider returned error", "HTTP 403",
        "HTTP 500", "HTTP 502", "HTTP 503",
        "rate limit exceeded for :free pool",
        "ReadTimeout: timed out after 120s",
        "TimeoutError: request timed out",
    ]
    for err in provider_failures:
        s = score(NUMERIC_Q, None, err)
        check(f"{err[:38]!r:42} -> {s.outcome}, not INCORRECT",
              s.outcome != INCORRECT and not s.is_scored)

    print("\n== the specific statuses seen live are classified correctly ==")
    check("429 -> PROVIDER_UNAVAILABLE", classify_failure("HTTP 429") == PROVIDER_UNAVAILABLE)
    check("403 agentic-harness -> PROVIDER_UNAVAILABLE",
          classify_failure("HTTP 403 only available on agentic harnesses") == PROVIDER_UNAVAILABLE)
    check("bare 'Provider returned error' -> PROVIDER_UNAVAILABLE",
          classify_failure("Provider returned error") == PROVIDER_UNAVAILABLE)
    check("timeout -> TIMEOUT", classify_failure("ReadTimeout") == TIMEOUT)
    check("SPLEX-side fault is NOT blamed on the provider",
          classify_failure("SPLEX internal error") == SPLEX_ERROR)

    print("\n== an empty 200 is unavailability, not a wrong answer ==")
    for empty in ["", "   ", "\n\n"]:
        s = score(NUMERIC_Q, empty)
        check(f"empty response {empty!r} -> {s.outcome}", s.outcome == PROVIDER_UNAVAILABLE)

    print("\n== genuine answers still score normally ==")
    check("correct answer -> CORRECT", score(NUMERIC_Q, "The answer is 42.").outcome == CORRECT)
    check("wrong answer -> INCORRECT", score(NUMERIC_Q, "The answer is 41.").outcome == INCORRECT)
    check("INCORRECT counts toward accuracy", INCORRECT in ACCURACY_OUTCOMES)
    check("PROVIDER_UNAVAILABLE does NOT", PROVIDER_UNAVAILABLE not in ACCURACY_OUTCOMES)
    check("TIMEOUT does NOT", TIMEOUT not in ACCURACY_OUTCOMES)
    check("SPLEX_ERROR does NOT", SPLEX_ERROR not in ACCURACY_OUTCOMES)
    check("NEEDS_REVIEW does NOT", NEEDS_REVIEW not in ACCURACY_OUTCOMES)

    print("\n== hallucination judgement is never auto-scored ==")
    s = score({"evaluation_method": "REFUSAL", "rubric": ["must reject the premise"],
               "must_not_contain": []}, "The Great Wall is visible from the Moon because...")
    check("REFUSAL quality -> NEEDS_REVIEW (not auto-CORRECT)", s.outcome == NEEDS_REVIEW)
    s2 = score({"evaluation_method": "RUBRIC", "rubric": ["x"]}, "anything at all")
    check("RUBRIC -> NEEDS_REVIEW", s2.outcome == NEEDS_REVIEW)
    # ...but an unambiguous mechanical violation IS caught automatically.
    s3 = score({"evaluation_method": "REFUSAL", "rubric": ["no url"],
                "must_not_contain": ["https://"]},
               "Here is your image: https://example.com/x.png")
    check("REFUSAL with a forbidden URL -> INCORRECT", s3.outcome == INCORRECT)

    print("\n== report: availability failures excluded from the accuracy denominator ==")
    rows = ([{"question_id": f"c{i}", "outcome": CORRECT} for i in range(70)]
            + [{"question_id": f"i{i}", "outcome": INCORRECT} for i in range(30)]
            + [{"question_id": f"p{i}", "outcome": PROVIDER_UNAVAILABLE} for i in range(50)])
    o = build(rows)["overall"]
    check("accuracy denominator is 100, not 150", o["accuracy_scored"] == 100)
    check("accuracy is 70.0%", o["accuracy_pct"] == 70.0)
    check("the 50 unavailable are reported separately", o["provider_unavailable"] == 50)
    check("availability is 100/150 = 66.7%", o["availability_pct"] == 66.7)

    print("\n== an all-unavailable run reports no accuracy, not 0% accuracy ==")
    o2 = build([{"question_id": f"p{i}", "outcome": PROVIDER_UNAVAILABLE} for i in range(20)])["overall"]
    check("accuracy_pct is None, NOT 0.0", o2["accuracy_pct"] is None)
    check("availability_pct is 0.0", o2["availability_pct"] == 0.0)

    print(f"\n{'ALL SCORING CHECKS PASSED' if not FAILURES else f'{len(FAILURES)} FAILURES'}")
    for f in FAILURES:
        print(f"  - {f}")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
