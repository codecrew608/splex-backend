"""Phase 2 runner. NOT executed during Phase 1.

Drives the real SPLEX chat endpoint as a FREE user, one corpus question per
request, and records what Cortex routed to, what came back, and how it scored.

Safety is layered deliberately, because a single check is a single point of
failure when real money is involved:

  L1  plan_tier is asserted 'free' before anything starts.
  L2  the live model_registry is compared against the audited snapshot; any
      drift aborts the run rather than proceeding on stale assumptions.
  L3  every routed model id reported back by the server is checked against
      the audited free list; the first non-free id aborts the entire run.
  L4  a hard ceiling on total requests, so a bug cannot loop.

L3 is the important one: it verifies what actually happened, not what was
supposed to happen.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass, asdict, field
from pathlib import Path

from .free_models import (
    assert_free_model, assert_free_plan, verify_inventory_matches_live,
    PaidCallBlocked, DISTINCT_FREE_MODEL_IDS,
)
from .evaluate import score, Score

CORPUS = Path(__file__).parent.parent / "corpus" / "corpus.jsonl"
REPORTS = Path(__file__).parent.parent / "reports"

# L4: nothing in this benchmark should ever need more than one request per
# question plus a small margin. A runaway loop stops here.
MAX_REQUESTS_HARD_CEILING = 2000


@dataclass
class Result:
    question_id: str
    category: str
    difficulty: str
    expected_capability: str
    evaluation_method: str
    outcome: str
    detail: str = ""
    routed_model: str | None = None
    routed_category: str | None = None
    used_fallback: bool = False
    latency_ms: int | None = None
    credits_charged: float | None = None
    response_excerpt: str = ""
    review_criteria: list[str] = field(default_factory=list)


def load_corpus() -> list[dict]:
    return [json.loads(line) for line in CORPUS.read_text().splitlines() if line.strip()]


def preflight(live_registry_rows: list[dict] | None) -> None:
    """Refuse to start unless every safety precondition holds."""
    assert_free_plan("free")

    if live_registry_rows is None:
        raise PaidCallBlocked(
            "REFUSING TO RUN: no live model_registry snapshot supplied. The audited "
            "free-model list must be re-verified against the database before any "
            "provider call, or the run proceeds on assumptions that may be stale."
        )

    problems = verify_inventory_matches_live(live_registry_rows)
    if problems:
        raise PaidCallBlocked(
            "REFUSING TO RUN: live model_registry has drifted from the audited snapshot:\n  "
            + "\n  ".join(problems)
            + "\n\nRe-audit bench/harness/free_models.py deliberately before running."
        )


def check_routed_model(model_id: str | None, question_id: str) -> None:
    """L3 — verify what the server ACTUALLY used, not what we expected."""
    if not model_id:
        return  # nothing reported; nothing to verify
    assert_free_model(model_id, context=f"question {question_id}")


def run_one(session, base_url: str, token: str, q: dict, timeout_s: int) -> Result:
    """Executes a single question against the live /chat endpoint.

    Intentionally NOT implemented against a mock: Phase 2's whole purpose is
    that the request travels the real Cortex path. Requires SPLEX_BENCH_TOKEN
    for a genuine Free-tier account.
    """
    import requests  # imported lazily: Phase 1 has no runtime dependency on it

    started = time.monotonic()
    routed_model = routed_category = None
    used_fallback = False
    credits = None
    text_parts: list[str] = []
    provider_error: str | None = None

    try:
        resp = session.post(
            f"{base_url.rstrip('/')}/chat",
            headers={"Authorization": f"Bearer {token}", "Accept": "text/event-stream"},
            json={"message": q["prompt"]},
            stream=True, timeout=timeout_s,
        )
        if resp.status_code != 200:
            # A transport/status failure is a PROVIDER FAILURE, never a wrong
            # answer — see evaluate.py's first principle.
            provider_error = f"HTTP {resp.status_code}"
        else:
            event = None
            for raw in resp.iter_lines(decode_unicode=True):
                if raw is None or raw == "":
                    continue
                if raw.startswith("event:"):
                    event = raw.split(":", 1)[1].strip()
                elif raw.startswith("data:"):
                    payload = raw.split(":", 1)[1].strip()
                    try:
                        data = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    if event == "token":
                        text_parts.append(data.get("delta", ""))
                    elif event == "cortex_decision":
                        routed_category = data.get("category")
                        # Model ids are internal; only present if the server
                        # exposes them. Checked immediately if so.
                        routed_model = data.get("model") or data.get("routedModel")
                        used_fallback = bool(data.get("usedFallback"))
                        check_routed_model(routed_model, q["question_id"])
                    elif event == "error":
                        provider_error = data.get("message", "error event")
                    elif event == "done":
                        credits = data.get("creditsCharged")
    except PaidCallBlocked:
        raise
    except Exception as e:  # noqa: BLE001 - transport failures are data here
        provider_error = f"{type(e).__name__}: {e}"

    latency_ms = int((time.monotonic() - started) * 1000)
    answer = "".join(text_parts).strip()
    s: Score = score(q, answer or None, provider_error)

    return Result(
        question_id=q["question_id"], category=q["category"], difficulty=q["difficulty"],
        expected_capability=q["expected_capability"], evaluation_method=q["evaluation_method"],
        outcome=s.outcome, detail=s.detail, routed_model=routed_model,
        routed_category=routed_category, used_fallback=used_fallback,
        latency_ms=latency_ms, credits_charged=credits,
        response_excerpt=answer[:400], review_criteria=s.criteria,
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="SPLEX free-model evaluation runner (Phase 2)")
    ap.add_argument("--base-url", default=os.environ.get("SPLEX_BENCH_URL"))
    ap.add_argument("--limit", type=int, default=None, help="run only the first N questions")
    ap.add_argument("--category", default=None, help="restrict to one corpus category")
    ap.add_argument("--timeout", type=int, default=120)
    ap.add_argument("--registry-json", default=None,
                    help="path to a live model_registry dump (required; see preflight)")
    ap.add_argument("--confirm-live", action="store_true",
                    help="required: acknowledges this makes real provider calls")
    args = ap.parse_args()

    if not args.confirm_live:
        print("Refusing to run without --confirm-live. This makes real (free-tier) "
              "provider calls and consumes free quota.", file=sys.stderr)
        return 2

    token = os.environ.get("SPLEX_BENCH_TOKEN")
    if not token or not args.base_url:
        print("SPLEX_BENCH_TOKEN and --base-url (or SPLEX_BENCH_URL) are required.", file=sys.stderr)
        return 2

    live_rows = None
    if args.registry_json:
        live_rows = json.loads(Path(args.registry_json).read_text())

    try:
        preflight(live_rows)
    except PaidCallBlocked as e:
        print(str(e), file=sys.stderr)
        return 3

    corpus = load_corpus()
    if args.category:
        corpus = [q for q in corpus if q["category"] == args.category]
    if args.limit:
        corpus = corpus[: args.limit]

    if len(corpus) > MAX_REQUESTS_HARD_CEILING:
        print(f"Refusing: {len(corpus)} questions exceeds the hard ceiling of "
              f"{MAX_REQUESTS_HARD_CEILING}.", file=sys.stderr)
        return 3

    import requests
    session = requests.Session()
    results: list[Result] = []

    print(f"Running {len(corpus)} questions as a FREE user against {args.base_url}")
    print(f"Audited free models: {len(DISTINCT_FREE_MODEL_IDS)}")

    try:
        for i, q in enumerate(corpus, 1):
            r = run_one(session, args.base_url, token, q, args.timeout)
            results.append(r)
            print(f"[{i}/{len(corpus)}] {r.question_id:24} {r.outcome:16} "
                  f"{(r.routed_model or '-'):45} {r.latency_ms}ms")
    except PaidCallBlocked as e:
        # Abort the WHOLE run: a paid model was reached, which invalidates the
        # run's central guarantee. Partial results are still written out.
        print(f"\n*** RUN ABORTED — PAID MODEL DETECTED ***\n{e}", file=sys.stderr)
        _write(results, aborted=True)
        return 4
    except KeyboardInterrupt:
        print("\ninterrupted; writing partial results", file=sys.stderr)

    _write(results, aborted=False)
    return 0


def _write(results: list[Result], aborted: bool) -> None:
    REPORTS.mkdir(exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    out = REPORTS / f"run-{stamp}.json"
    out.write_text(json.dumps({
        "aborted_due_to_paid_model": aborted,
        "total": len(results),
        "results": [asdict(r) for r in results],
    }, indent=2))
    print(f"\nwrote {out} ({len(results)} results)")


if __name__ == "__main__":
    raise SystemExit(main())
