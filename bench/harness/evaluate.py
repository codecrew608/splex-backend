"""Scoring. One function per evaluation method.

Two principles run through this file:

1. A PROVIDER FAILURE IS NOT A WRONG ANSWER. A 429 or a timeout says nothing
   about the model's ability. Those are recorded as `provider_failure` and
   excluded from accuracy denominators, because folding them in would make a
   rate-limited model look stupid rather than throttled.

2. RUBRIC/REFUSAL items are NOT auto-scored by a model here. Using an LLM to
   grade an LLM on exactly the axis being measured (does it hallucinate?)
   imports the failure into the measurement. Those are marked
   `needs_human_review` with the criteria attached, and are reported as a
   separate bucket rather than silently counted as correct.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any

import sympy as sp
from sympy.parsing.sympy_parser import (
    parse_expr, standard_transformations, implicit_multiplication_application,
    convert_xor,
)

from .sandbox import grade_programmatic

# Models overwhelmingly write "3x^2", not "3*x**2". Parsing only strict sympy
# syntax would mark correct algebra wrong for notational reasons — measuring
# formatting instead of mathematics. These transformations accept the notation
# humans (and models) actually use.
_TRANSFORMS = standard_transformations + (implicit_multiplication_application, convert_xor)


def _parse_math(text: str):
    """Parse leniently, returning None rather than raising."""
    try:
        return parse_expr(text, transformations=_TRANSFORMS, evaluate=True)
    except Exception:
        return None


# The outcome taxonomy. The split that matters most is ACCURACY vs
# AVAILABILITY: a 429 says nothing about whether a model can do maths, so
# folding provider failures into an accuracy denominator would report a
# throttled provider as a stupid one.
#
# Only CORRECT / INCORRECT / PARTIAL enter the accuracy denominator.
# Everything else is an infrastructure or process result and is reported
# separately.
CORRECT = "CORRECT"
INCORRECT = "INCORRECT"
PARTIAL = "PARTIAL"
# Answered when the expected behaviour was a refusal or "cannot determine"
# (or refused when an answer was expected) — a distinct failure mode from
# simply getting the maths wrong, and the one hallucination tests target.
UNSAFE_REFUSAL_MISMATCH = "UNSAFE_REFUSAL_MISMATCH"
PROVIDER_UNAVAILABLE = "PROVIDER_UNAVAILABLE"   # 429/403/5xx from upstream
TIMEOUT = "TIMEOUT"
SPLEX_ERROR = "SPLEX_ERROR"                     # SPLEX itself failed, not the provider
SKIPPED_CAPABILITY = "SKIPPED_CAPABILITY"       # no free model supports this at all
BENCHMARK_ERROR = "BENCHMARK_ERROR"             # the harness broke, not the product
NEEDS_REVIEW = "NEEDS_REVIEW"                   # rubric/refusal quality, human judgement

ACCURACY_OUTCOMES = frozenset({CORRECT, INCORRECT, PARTIAL, UNSAFE_REFUSAL_MISMATCH})
AVAILABILITY_FAILURES = frozenset({PROVIDER_UNAVAILABLE, TIMEOUT})
NON_ACCURACY = frozenset({
    PROVIDER_UNAVAILABLE, TIMEOUT, SPLEX_ERROR, SKIPPED_CAPABILITY,
    BENCHMARK_ERROR, NEEDS_REVIEW,
})


@dataclass
class Score:
    outcome: str
    detail: str = ""
    partial: float | None = None    # 0..1 where partial credit is meaningful
    criteria: list[str] = field(default_factory=list)

    @property
    def is_scored(self) -> bool:
        """Whether this counts toward an ACCURACY denominator.

        PARTIAL and UNSAFE_REFUSAL_MISMATCH count: the model did generate an
        answer, it was just wrong or wrongly-shaped. Availability failures do
        not, because no answer was produced to judge.
        """
        return self.outcome in ACCURACY_OUTCOMES

    @property
    def is_availability_failure(self) -> bool:
        return self.outcome in AVAILABILITY_FAILURES

    @property
    def credit(self) -> float:
        """Accuracy credit in [0,1]. PARTIAL contributes its fraction."""
        if self.outcome == CORRECT:
            return 1.0
        if self.outcome == PARTIAL:
            return self.partial if self.partial is not None else 0.5
        return 0.0


_NUM_RE = re.compile(r"-?\d[\d,]*\.?\d*(?:[eE][-+]?\d+)?")


def _extract_numbers(text: str) -> list[float]:
    out = []
    for m in _NUM_RE.finditer(text.replace(",", "")):
        try:
            out.append(float(m.group()))
        except ValueError:
            pass
    return out


def score_numeric(response: str, gold: float, tolerance: float) -> Score:
    """Accepts the answer if ANY number in the response matches.

    Deliberately lenient about surrounding prose but strict about the value:
    prompts ask for 'only the number', yet penalising a correct answer for
    saying 'The answer is 42.' would measure formatting, not arithmetic.
    Formatting compliance is measured separately, by the STRUCTURE items.
    """
    nums = _extract_numbers(response)
    if not nums:
        return Score(INCORRECT, "no numeric value found in response")
    for v in nums:
        if math.isclose(v, gold, abs_tol=tolerance, rel_tol=0):
            return Score(CORRECT, f"matched {v}")
    # The LAST number is usually the final answer; report it for diagnosis.
    return Score(INCORRECT, f"expected {gold} (+/-{tolerance}), got {nums[-1]!r} (all: {nums[:5]})")


def score_exact(response: str, gold: str) -> Score:
    norm = re.sub(r"[^\w\s^]", " ", response.lower())
    norm = re.sub(r"\s+", " ", norm).strip()
    g = str(gold).lower().strip()
    if g in norm.split() or g in norm:
        return Score(CORRECT, f"found {gold!r}")
    return Score(INCORRECT, f"expected {gold!r}; response did not contain it")


def score_symbolic(response: str, gold: str) -> Score:
    """Symbolic equivalence, so x+1 and 1+x both pass.

    Falls back to a normalised string comparison when the response cannot be
    parsed — many correct answers arrive as prose containing the expression.
    """
    gold_str = str(gold)
    # Pull out MATH-looking runs, not raw regex slabs: "The derivative is
    # -4 + 3*x^2" must yield "-4 + 3*x^2", because sympify chokes on the
    # English. A token counts as mathematical if it is a number, a single
    # letter (variable), an operator, or a known function name; maximal
    # contiguous runs of such tokens become the candidates.
    _FUNCS = {"sin", "cos", "tan", "log", "ln", "exp", "sqrt", "abs", "pi", "e", "oo", "I"}

    def _math_candidates(text: str) -> list[str]:
        spaced = re.sub(r"([-+*/^()=,])", r" \1 ", text)
        runs, cur = [], []
        for tok in spaced.split():
            t = tok.strip().rstrip(".")
            if not t:
                continue
            ok = (
                re.fullmatch(r"-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?", t)
                or re.fullmatch(r"[-+*/^()=,]", t)
                or re.fullmatch(r"[a-zA-Z]", t)
                or t.lower() in _FUNCS
                or re.fullmatch(r"[a-zA-Z]\*\*\d+", t)
                # implicit-multiplication forms models actually emit: 3x, 3x^2, x^2
                or re.fullmatch(r"\d*[a-zA-Z](?:\^\d+|\*\*\d+)?", t)
            )
            if ok:
                cur.append(t)
            else:
                if cur:
                    runs.append(" ".join(cur))
                cur = []
        if cur:
            runs.append(" ".join(cur))
        # Function-call forms like "log(xy)" or "sqrt(2)": the argument may be
        # an implicit product of variables ("xy"), which the token classifier
        # above cannot distinguish from an English word, so capture the whole
        # call directly.
        for m in re.finditer(r"\b([a-zA-Z]{1,6})\s*\(([^()]{1,60})\)", text):
            if m.group(1).lower() in _FUNCS:
                runs.append(m.group(0))
        # Also try the whole trailing clause after "=" or ":".
        for sep in ("=", ":"):
            if sep in text:
                runs.append(text.rsplit(sep, 1)[-1].strip().rstrip("."))
        return [r for r in runs if r]

    candidates = _math_candidates(response)
    gold_expr = _parse_math(gold_str)

    if gold_expr is not None:
        for cand in sorted(candidates, key=len, reverse=True)[:20]:
            c = cand.strip().rstrip(".").split("=")[-1].strip()
            if not c or c in "+-*/^(),":
                continue
            expr = _parse_math(c)
            if expr is None:
                continue
            try:
                if (expr.free_symbols or expr.is_number) and sp.simplify(expr - gold_expr) == 0:
                    return Score(CORRECT, f"symbolically equal to {gold_str}")
            except Exception:
                continue

    # Multi-part gold ("2, 3"): require every component to appear.
    parts = [p.strip() for p in gold_str.split(",") if p.strip()]
    if len(parts) > 1 and all(p.lower() in response.lower() for p in parts):
        return Score(CORRECT, f"all components present: {gold_str}")

    if gold_str.lower().replace(" ", "") in response.lower().replace(" ", ""):
        return Score(CORRECT, f"literal match for {gold_str}")
    return Score(INCORRECT, f"expected {gold_str!r}; no equivalent expression found")


def score_reference(response: str, facts: list[str], must_not: list[str]) -> Score:
    low = response.lower()
    missing = [f for f in facts if f.lower() not in low]
    present_bad = [b for b in must_not if b.lower() in low]
    if present_bad:
        return Score(INCORRECT, f"contains forbidden content: {present_bad}")
    if missing:
        got = len(facts) - len(missing)
        return Score(INCORRECT, f"missing required facts: {missing}", partial=got / len(facts))
    return Score(CORRECT, f"all {len(facts)} reference facts present")


def score_structure(response: str, criteria: list[str]) -> Score:
    """Structural constraints that can be checked mechanically.

    Only the constraints this function actually understands are auto-checked;
    anything else is handed to review rather than guessed at.
    """
    checks: list[tuple[str, bool]] = []
    low = response.strip()

    for c in criteria:
        cl = c.lower()
        if "no letter 'e'" in cl or "contains no letter 'e'" in cl:
            checks.append((c, "e" not in low.lower()))
        elif "no backslash" in cl:
            checks.append((c, "\\" not in low))
        elif "no dollar sign" in cl:
            checks.append((c, "$" not in low))
        elif "exactly one line" in cl:
            checks.append((c, len([l for l in low.splitlines() if l.strip()]) == 1))
        elif "exactly two sentences" in cl:
            checks.append((c, len([s for s in re.split(r"[.!?]+", low) if s.strip()]) == 2))
        elif "all lowercase" in cl:
            checks.append((c, low == low.lower()))
        elif "no spaces after commas" in cl:
            checks.append((c, ", " not in low))
        elif "no trailing period" in cl:
            checks.append((c, not low.endswith(".")))
        elif "three comma-separated" in cl:
            checks.append((c, len(low.split(",")) == 3))
        # anything else: not mechanically checkable here

    if not checks:
        return Score(NEEDS_REVIEW, "no mechanically checkable criteria", criteria=criteria)
    passed = sum(1 for _, ok in checks if ok)
    failed = [c for c, ok in checks if not ok]
    if passed == len(checks):
        return Score(CORRECT, f"all {passed} structural constraints met")
    return Score(INCORRECT, f"failed: {failed}", partial=passed / len(checks))


def score_refusal(response: str, must_not: list[str], criteria: list[str]) -> Score:
    """A hard, mechanical pre-check, then human review for the rest.

    The `must_not_contain` list catches the unambiguous failures (a media
    refusal that nonetheless returns a URL). The nuanced part — did it
    actually reject the false premise? — is exactly what an LLM judge would be
    unreliable at, so it goes to review with the criteria attached.
    """
    low = response.lower()
    violations = [b for b in must_not if b.lower() in low]
    if violations:
        return Score(INCORRECT, f"contains content it should not: {violations}")
    return Score(NEEDS_REVIEW, "refusal quality requires human judgement", criteria=criteria)


def score_rubric(criteria: list[str]) -> Score:
    return Score(NEEDS_REVIEW, "rubric scoring requires human judgement", criteria=criteria)


def classify_failure(provider_error: str) -> str:
    """Sort a failure into the taxonomy.

    The distinction that matters: an UPSTREAM provider problem (429/403/5xx,
    timeouts) is an availability result, whereas a SPLEX-side fault is a
    product defect. Collapsing them would hide our own bugs inside the
    provider's error rate.
    """
    e = provider_error.lower()
    if "timeout" in e or "timed out" in e or "readtimeout" in e:
        return TIMEOUT
    # Upstream provider statuses, including the shared :free pool saturation
    # (429) and the agentic-harness restriction (403).
    if any(t in e for t in ("429", "403", "500", "502", "503", "504",
                            "rate limit", "provider returned error")):
        return PROVIDER_UNAVAILABLE
    if "capability" in e or "unavailable on your plan" in e:
        return SKIPPED_CAPABILITY
    # 4xx that is not a provider limit, or an explicit SPLEX message, is ours.
    if any(t in e for t in ("http 4", "http 5", "splex")):
        return SPLEX_ERROR
    return PROVIDER_UNAVAILABLE


def score(question: dict, response: str | None, provider_error: str | None = None) -> Score:
    """Single entry point. `provider_error` short-circuits everything.

    Nothing below this line can turn an unavailable provider into an
    INCORRECT answer — that conversion is the single easiest way to produce
    a misleading accuracy number, so it is structurally impossible here.
    """
    if provider_error:
        return Score(classify_failure(provider_error), provider_error)
    if response is None:
        return Score(PROVIDER_UNAVAILABLE, "no response returned")
    if not response.strip():
        # An empty 200 is a provider producing nothing, not a wrong answer.
        return Score(PROVIDER_UNAVAILABLE, "empty response body")

    m = question["evaluation_method"]
    if m == "NUMERIC":
        return score_numeric(response, float(question["gold_answer"]), float(question["tolerance"]))
    if m == "EXACT":
        return score_exact(response, question["gold_answer"])
    if m == "SYMBOLIC":
        return score_symbolic(response, question["gold_answer"])
    if m == "PROGRAMMATIC":
        r = grade_programmatic(response, question["hidden_tests"])
        if r.passed:
            return Score(CORRECT, "all hidden tests passed")
        if r.stage == "extract":
            return Score(INCORRECT, "no code block found in response")
        return Score(INCORRECT, f"{r.stage}: {(r.error or '')[:300]}")
    if m == "REFERENCE":
        return score_reference(response, question.get("reference_facts", []),
                               question.get("must_not_contain", []))
    if m == "STRUCTURE":
        return score_structure(response, question.get("rubric", []))
    if m == "REFUSAL":
        return score_refusal(response, question.get("must_not_contain", []),
                             question.get("rubric", []))
    if m == "RUBRIC":
        return score_rubric(question.get("rubric", []))
    return Score(NEEDS_REVIEW, f"unknown evaluation method {m!r}")
