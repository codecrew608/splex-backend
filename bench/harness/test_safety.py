"""Tests for the paid-call guard. Run: python3 -m bench.harness.test_safety

This is the one part of the benchmark that must not be wrong. If the guard
fails open, the whole 'no paid credits' guarantee is void, so it is tested
directly rather than assumed.
"""

from __future__ import annotations

import sys

from .free_models import (
    assert_free_model, assert_free_plan, is_free_model_id, PaidCallBlocked,
    verify_inventory_matches_live, FREE_MODELS, DISTINCT_FREE_MODEL_IDS,
    FREE_UNAVAILABLE_CATEGORIES,
)
from .runner import check_routed_model, preflight

FAILURES: list[str] = []


def check(label: str, cond: bool) -> None:
    print(f"  {'PASS' if cond else 'FAIL'}  {label}")
    if not cond:
        FAILURES.append(label)


def expect_blocked(label: str, fn) -> None:
    try:
        fn()
    except PaidCallBlocked:
        check(label, True)
        return
    check(label + "  <-- DID NOT BLOCK", False)


def main() -> int:
    print("\n== every audited model is recognised as free ==")
    for mid in DISTINCT_FREE_MODEL_IDS:
        check(f"accepts {mid}", is_free_model_id(mid))

    print("\n== paid / unknown models are refused ==")
    for mid in [
        "qwen/qwen-2.5-72b-instruct",          # the configured PAID classifier
        "openai/gpt-4o",
        "anthropic/claude-3-5-sonnet",
        "google/gemini-2.0-flash",
        "z-ai/glm-5.2",                        # same family, NOT the :free variant
        "nvidia/nemotron-3-super-120b-a12b",   # ditto
    ]:
        check(f"rejects {mid}", not is_free_model_id(mid))
        expect_blocked(f"blocks {mid}", lambda m=mid: assert_free_model(m))

    print("\n== an UNAUDITED ':free' id is still refused ==")
    # The suffix alone must not be sufficient: a model this benchmark has not
    # audited could be mispriced or miscategorised upstream.
    check("unknown :free id rejected", not is_free_model_id("someone/unknown-model:free"))
    expect_blocked("blocks unknown :free id",
                   lambda: assert_free_model("someone/unknown-model:free"))

    print("\n== plan tier ==")
    assert_free_plan("free")
    check("accepts free tier", True)
    for tier in ["pro", "starter", "enterprise", "FREE", ""]:
        expect_blocked(f"blocks plan_tier={tier!r}", lambda t=tier: assert_free_plan(t))

    print("\n== runner L3: a paid model reported mid-run aborts ==")
    check_routed_model(None, "q1")
    check("None routed model is tolerated", True)
    check_routed_model("z-ai/glm-5.2:free", "q1")
    check("free routed model passes", True)
    expect_blocked("paid routed model aborts the run",
                   lambda: check_routed_model("openai/gpt-4o", "q1"))

    print("\n== preflight refuses without a live registry check ==")
    expect_blocked("no registry snapshot -> refuse", lambda: preflight(None))

    print("\n== preflight detects registry drift ==")
    live_ok = [
        {"category": m.category, "openrouter_model_id": m.model_id,
         "variant": "free", "is_active": True, "free_tier_allowed": True}
        for m in FREE_MODELS
    ]
    check("matching registry produces no problems",
          verify_inventory_matches_live(live_ok) == [])

    drifted = live_ok + [{"category": "math", "openrouter_model_id": "new/model:free",
                          "variant": "free", "is_active": True, "free_tier_allowed": True}]
    check("new live model is detected as drift",
          any("NEW free model" in p for p in verify_inventory_matches_live(drifted)))
    expect_blocked("drifted registry -> refuse to run", lambda: preflight(drifted))

    removed = live_ok[:-1]
    check("removed model is detected as drift",
          any("no longer live" in p for p in verify_inventory_matches_live(removed)))

    not_actually_free = [dict(live_ok[0], variant="paid")]
    check("a non-free row returned as free is caught",
          any("not free-reachable" in p for p in verify_inventory_matches_live(not_actually_free)))

    print("\n== free-tier media categories have no free model ==")
    audited_categories = {m.category for m in FREE_MODELS}
    for cat in FREE_UNAVAILABLE_CATEGORIES:
        check(f"{cat} has no free-reachable model", cat not in audited_categories)

    print(f"\n{'ALL SAFETY CHECKS PASSED' if not FAILURES else f'{len(FAILURES)} FAILURES'}")
    for f in FAILURES:
        print(f"  - {f}")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
