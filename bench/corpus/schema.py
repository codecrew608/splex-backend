"""Corpus record schema, validation, and duplicate detection.

Every question in the corpus is one Question record. The schema is enforced
at build time (build.py refuses to emit an invalid corpus) so a malformed
record can never reach the runner and be silently scored as a failure.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass, field, asdict
from typing import Any

# --- controlled vocabularies -------------------------------------------------

DIFFICULTIES = ["easy", "medium", "hard", "extreme", "adversarial"]

# How a response is judged. Chosen per question at authoring time, because
# the right method is a property of the question, not of the answer.
EVAL_METHODS = [
    "NUMERIC",        # numeric answer within tolerance
    "EXACT",          # exact string/token match after normalisation
    "SYMBOLIC",       # sympy-equivalent expression
    "PROGRAMMATIC",   # run generated code against hidden tests
    "REFERENCE",      # must contain/agree with reference facts
    "RUBRIC",         # scored against explicit criteria
    "REFUSAL",        # correct behaviour is a refusal / "cannot determine"
    "STRUCTURE",      # output must satisfy a structural constraint
]

QUESTION_TYPES = [
    "computation", "conceptual", "multi_step", "reverse", "unit_conversion",
    "boundary", "misconception", "false_premise", "insufficient_info",
    "ambiguous", "instruction_following", "code_implement", "code_debug",
    "code_explain", "comprehension", "summarization", "classification",
    "capability_probe", "refusal_expected",
]

# Cortex categories a Free user can be routed into (see harness/free_models.py).
FREE_CATEGORIES = [
    "coding", "documents", "general", "math", "reasoning",
    "vision", "web_search", "writing",
]

COMPLEXITIES = ["simple", "medium", "complex"]


@dataclass
class Question:
    question_id: str
    group_id: str
    category: str            # corpus domain, e.g. "physics"
    subcategory: str
    skill: str
    difficulty: str
    question_type: str
    prompt: str

    # What Cortex *should* do with this. Routing correctness is scored
    # separately from answer correctness, so these are expectations about
    # the router, not about the answer.
    expected_capability: str      # a FREE_CATEGORIES value, or "unavailable"
    expected_complexity: str

    evaluation_method: str
    adversarial_level: int = 0    # 0 none .. 3 deliberately deceptive

    gold_answer: Any = None       # for NUMERIC/EXACT/SYMBOLIC
    tolerance: float | None = None
    unit: str | None = None
    rubric: list[str] = field(default_factory=list)
    reference_facts: list[str] = field(default_factory=list)
    must_not_contain: list[str] = field(default_factory=list)
    hidden_tests: str | None = None   # python source for PROGRAMMATIC
    source: str | None = None
    notes: str | None = None
    # Deliberate minimal pair with another question_id. Two items that differ
    # by one word ("WITH" vs "WITHOUT replacement") are near-identical as text
    # but probe opposite behaviours — that contrast is the experiment, so it
    # is declared here rather than being silently dropped as a duplicate.
    # `notes` must explain what the contrast tests.
    minimal_pair_of: str | None = None

    def to_json(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v not in (None, [], "")}


# --- validation --------------------------------------------------------------

class CorpusError(ValueError):
    pass


def validate(q: Question) -> None:
    if q.difficulty not in DIFFICULTIES:
        raise CorpusError(f"{q.question_id}: bad difficulty {q.difficulty!r}")
    if q.evaluation_method not in EVAL_METHODS:
        raise CorpusError(f"{q.question_id}: bad evaluation_method {q.evaluation_method!r}")
    if q.question_type not in QUESTION_TYPES:
        raise CorpusError(f"{q.question_id}: bad question_type {q.question_type!r}")
    if q.expected_capability not in FREE_CATEGORIES + ["unavailable"]:
        raise CorpusError(f"{q.question_id}: bad expected_capability {q.expected_capability!r}")
    if q.expected_complexity not in COMPLEXITIES:
        raise CorpusError(f"{q.question_id}: bad expected_complexity {q.expected_complexity!r}")
    if not q.prompt.strip():
        raise CorpusError(f"{q.question_id}: empty prompt")

    # Every question must actually be gradeable. A question with no gold
    # answer, no rubric and no reference is unscoreable, and unscoreable
    # questions quietly become "wrong" in the results.
    m = q.evaluation_method
    if m in ("NUMERIC", "EXACT", "SYMBOLIC") and q.gold_answer is None:
        raise CorpusError(f"{q.question_id}: {m} requires gold_answer")
    if m == "NUMERIC" and q.tolerance is None:
        raise CorpusError(f"{q.question_id}: NUMERIC requires tolerance")
    if m == "RUBRIC" and not q.rubric:
        raise CorpusError(f"{q.question_id}: RUBRIC requires rubric criteria")
    if m == "REFERENCE" and not q.reference_facts:
        raise CorpusError(f"{q.question_id}: REFERENCE requires reference_facts")
    if m == "PROGRAMMATIC" and not q.hidden_tests:
        raise CorpusError(f"{q.question_id}: PROGRAMMATIC requires hidden_tests")
    if m == "REFUSAL" and not (q.rubric or q.must_not_contain):
        raise CorpusError(f"{q.question_id}: REFUSAL requires rubric or must_not_contain")
    if q.adversarial_level not in (0, 1, 2, 3):
        raise CorpusError(f"{q.question_id}: bad adversarial_level {q.adversarial_level}")

    # Provenance is mandatory. A gold answer whose origin is unrecorded cannot
    # be weighted by a reader — "computed by sympy" and "recalled by a model"
    # deserve very different confidence, and without this field they look
    # identical in the results.
    if not (q.source and q.source.strip()):
        raise CorpusError(f"{q.question_id}: missing source/justification for its answer key")


# --- duplicate detection -----------------------------------------------------

_NUM = re.compile(r"-?\d+(?:\.\d+)?")
_WS = re.compile(r"\s+")
# Prose punctuation is noise; MATHEMATICAL operators are content. Stripping
# everything non-word made "8 - 3 * 2 + 1" and "(8 - 3) * (2 + 1)" normalise
# to the same string — flagging two genuinely different precedence questions
# as exact duplicates. Operators and grouping are kept, and spaced out so they
# tokenise separately.
_MATH_CHARS = "+-*/^()=<>%"
_PUNCT = re.compile(r"[^\w\s" + re.escape(_MATH_CHARS) + r"]")
_MATH_SPLIT = re.compile("([" + re.escape(_MATH_CHARS) + "])")


def normalise(text: str) -> str:
    t = unicodedata.normalize("NFKC", text).lower()
    t = _PUNCT.sub(" ", t)
    t = _MATH_SPLIT.sub(r" \1 ", t)
    return _WS.sub(" ", t).strip()


def exact_key(text: str) -> str:
    return hashlib.sha256(normalise(text).encode()).hexdigest()


def skeleton_key(text: str) -> str:
    """Numbers replaced by a placeholder.

    Two questions sharing a skeleton are the same template with different
    numbers. That is NOT automatically a duplicate — changing 9.8 to 1.6
    turns an Earth gravity question into a Moon one, and boundary values
    (0, 1, negatives) probe genuinely different behaviour. So the build
    treats a shared skeleton as a duplicate only when the generator has not
    explicitly declared the variation meaningful (see build.py).
    """
    return hashlib.sha256(_NUM.sub("#", normalise(text)).encode()).hexdigest()


def token_set(text: str) -> frozenset[str]:
    return frozenset(normalise(text).split())


def jaccard(a: frozenset[str], b: frozenset[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)
