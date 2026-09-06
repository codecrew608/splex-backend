"""SIB v1.0 — category mapping, weights, sampling and aggregation.

Everything in this module is fixed by bench/SIB-v1.0-SPEC.md and was written
before any result existed. It is imported by both the SPLEX runner and the
baseline runner so that a comparison cannot accidentally use a different
mapping, a different weight set, or a different sample.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

CORPUS = Path(__file__).parent.parent / "corpus" / "corpus.jsonl"
EXT = Path(__file__).parent.parent / "corpus" / "sib_ext.jsonl"

BENCHMARK_VERSION = "SIB v1.0"

# ---------------------------------------------------------------------------
# Pre-registered weights (SIB-v1.0-SPEC.md §2). Do not edit after a run
# without recording an amendment in that file.
# ---------------------------------------------------------------------------
WEIGHTS: dict[str, float] = {
    "mathematics": 0.14,
    "reasoning": 0.14,
    "coding": 0.12,
    "knowledge": 0.12,
    "instruction_following": 0.10,
    "hallucination_resistance": 0.10,
    "long_context": 0.08,
    "multilingual": 0.08,
    "safety": 0.06,
    "structured_output": 0.06,
}
assert abs(sum(WEIGHTS.values()) - 1.0) < 1e-9, "SIB weights must sum to 1.0"

# corpus `category` -> SIB category. Every corpus category must appear here;
# an unmapped one is a hard error rather than a silent drop, because silently
# dropping items is how a benchmark quietly stops measuring what it claims.
CATEGORY_MAP: dict[str, str] = {
    # mathematics
    "arithmetic": "mathematics", "algebra": "mathematics", "fractions": "mathematics",
    "geometry": "mathematics", "trigonometry": "mathematics", "statistics": "mathematics",
    "probability": "mathematics", "unit_conversion": "mathematics",
    "mathematics": "mathematics",
    # reasoning
    "logical_reasoning": "reasoning", "adversarial_reasoning": "reasoning",
    "physics": "reasoning", "reading_comprehension": "reasoning",
    "business": "reasoning",
    # coding
    "coding": "coding", "computer_science": "coding", "cybersecurity": "coding",
    # knowledge / factuality
    "chemistry": "knowledge", "biology": "knowledge", "geography": "knowledge",
    "history": "knowledge", "astronomy": "knowledge", "earth_science": "knowledge",
    "general_knowledge": "knowledge", "language": "knowledge",
    # instruction following
    "instruction_following": "instruction_following", "summarization": "instruction_following",
    # hallucination resistance
    "hallucination_resistance": "hallucination_resistance",
    "current_information": "hallucination_resistance",
    "ambiguity_handling": "hallucination_resistance",
    # long context
    "long_context": "long_context", "file_understanding": "long_context",
    # safety
    "safety_refusal": "safety", "adversarial_input": "safety",
    # structured output
    "structured_output": "structured_output", "latex": "structured_output",
    # SIB-EXT categories (bench/corpus/generators/sib_ext.py)
    "multilingual": "multilingual",
    # platform concerns — measured by SSB, excluded from SIB entirely
    "routing": None, "media_intent": None, "vision": None,
}

# SIB categories fed by the extension set authored this session.
EXT_CATEGORIES = {"multilingual", "long_context", "instruction_following"}


def sib_category(row: dict) -> str | None:
    """None means 'deliberately not part of SIB' (an SSB concern)."""
    cat = row["category"]
    if cat not in CATEGORY_MAP:
        raise KeyError(
            f"corpus category {cat!r} has no SIB mapping. Add it to CATEGORY_MAP "
            "deliberately — silently dropping items corrupts the denominator."
        )
    return CATEGORY_MAP[cat]


def load_corpus() -> list[dict]:
    rows = [json.loads(l) for l in CORPUS.read_text().splitlines() if l.strip()]
    if EXT.exists():
        rows += [json.loads(l) for l in EXT.read_text().splitlines() if l.strip()]
    return rows


# ---------------------------------------------------------------------------
# Sampling
# ---------------------------------------------------------------------------

def _stable_key(question_id: str, seed: str) -> str:
    """Deterministic ordering that does not depend on Python's hash seed, so
    the same sample is reproducible across machines and runs."""
    return hashlib.sha256(f"{seed}:{question_id}".encode()).hexdigest()


@dataclass
class SampleQuota:
    category: str
    target: int
    available: int
    taken: int


def stratified_sample(rows: list[dict], budget: int, seed: str = "sib-v1.0",
                      auto_only: bool = True) -> tuple[list[dict], list[SampleQuota]]:
    """Allocate `budget` items across SIB categories in proportion to weight.

    Two deliberate choices:
      - Allocation follows the PRE-REGISTERED weights, not the corpus's own
        skew. The inherited corpus is ~60% mathematics; sampling it
        proportionally would produce a maths benchmark wearing a general
        benchmark's name.
      - Items whose scoring needs a human (RUBRIC) are excluded by default.
        They cannot contribute to an automatic score, so spending scarce
        live quota on them buys nothing.
    """
    pool: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        cat = sib_category(r)
        if cat is None:
            continue
        if auto_only and r["evaluation_method"] in ("RUBRIC",):
            continue
        pool[cat].append(r)

    for cat in pool:
        pool[cat].sort(key=lambda r: _stable_key(r["question_id"], seed))

    # Largest-remainder allocation, so rounding cannot silently lose or
    # invent items relative to the budget.
    raw = {c: budget * w for c, w in WEIGHTS.items()}
    alloc = {c: int(math.floor(v)) for c, v in raw.items()}
    remainder = budget - sum(alloc.values())
    for c, _ in sorted(raw.items(), key=lambda kv: kv[1] - math.floor(kv[1]), reverse=True):
        if remainder <= 0:
            break
        alloc[c] += 1
        remainder -= 1

    # A category with fewer items than its allocation gives the surplus back
    # to categories that can actually use it.
    quotas: list[SampleQuota] = []
    picked: list[dict] = []
    surplus = 0
    for cat in WEIGHTS:
        want = alloc[cat]
        have = len(pool.get(cat, []))
        take = min(want, have)
        surplus += want - take
        picked += pool[cat][:take]
        quotas.append(SampleQuota(cat, want, have, take))

    if surplus:
        for q in quotas:
            if surplus <= 0:
                break
            spare = q.available - q.taken
            extra = min(spare, surplus)
            if extra > 0:
                picked += pool[q.category][q.taken:q.taken + extra]
                q.taken += extra
                surplus -= extra

    picked.sort(key=lambda r: _stable_key(r["question_id"], seed))
    return picked, quotas


# ---------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------

def wilson_interval(successes: float, n: int, z: float = 1.959963985) -> tuple[float, float]:
    """95% Wilson score interval, in percent.

    Chosen over the normal approximation because this benchmark's per-category
    n is small and several categories will sit near 0% or 100%, exactly where
    the normal approximation produces intervals that leave [0,1].
    """
    if n == 0:
        return (0.0, 100.0)
    p = successes / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = (z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denom
    return (max(0.0, (centre - half) * 100), min(100.0, (centre + half) * 100))


def intervals_separate(a: tuple[float, float], b: tuple[float, float]) -> bool:
    """Non-overlapping 95% intervals — the spec's bar for calling a
    difference meaningful. Conservative on purpose."""
    return a[1] < b[0] or b[1] < a[0]


def pp_and_relative(a: float, b: float) -> tuple[float, float | None]:
    """(percentage-point difference, relative % difference).

    Kept in one function precisely because conflating these two is the most
    common way benchmark write-ups mislead.
    """
    pp = a - b
    rel = None if b == 0 else (a - b) / b * 100
    return pp, rel
