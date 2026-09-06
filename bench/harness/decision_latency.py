"""Measures time-to-routing-decision on the deployed system.

The LLM classifier runs BEFORE generation, so its cost lands entirely in the
gap between the request leaving and the `cortex_decision` event arriving.
That gap is measurable without a single successful generation — which makes
this the one part of the latency fix that can be verified while the
free-model generation quota is exhausted.

Messages are labelled by which path they take so the two groups can be
compared directly rather than pooled into one average that hides the effect.
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
import urllib.error
import urllib.request
from pathlib import Path

USER_AGENT = "SPLEX-Benchmark/1.0 (SIB v1.0)"

# Deliberately a mix. The "keyword" group must resolve from the intent table;
# the "classifier" group is phrased to match nothing, so it has to pay for the
# LLM round-trip. Neither group is drawn from the benchmark corpus.
PROBES: list[tuple[str, str]] = [
    ("keyword", "What is 17 × 23?"),
    ("keyword", "What is 25% of 800?"),
    ("keyword", "What is the square root of 144?"),
    ("keyword", "Convert 12 miles to kilometres"),
    ("keyword", "Write a Python function that merges two sorted lists"),
    ("keyword", "Summarise the key takeaways from this report"),
    ("classifier", "the thing from before, sort of"),
    ("classifier", "hmm not sure about that one honestly"),
    ("classifier", "could you maybe have a look at it for me"),
    ("classifier", "any thoughts on the earlier item"),
]


def time_to_decision(base_url: str, token: str, origin: str, message: str,
                     timeout: int) -> dict:
    body = json.dumps({"message": message}).encode()
    req = urllib.request.Request(f"{base_url.rstrip('/')}/chat", data=body, method="POST")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "text/event-stream")
    req.add_header("Origin", origin)
    req.add_header("User-Agent", USER_AGENT)

    started = time.monotonic()
    out: dict = {"decision_ms": None, "label": None, "reason": None, "error": None}
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            event = None
            for raw in r:
                line = raw.decode("utf-8", "replace").rstrip("\n")
                if line.startswith("event:"):
                    event = line.split(":", 1)[1].strip()
                elif line.startswith("data:") and event == "cortex_decision":
                    out["decision_ms"] = int((time.monotonic() - started) * 1000)
                    d = json.loads(line.split(":", 1)[1].strip())
                    out["label"] = d.get("categoryLabel")
                    out["reason"] = d.get("reason", "")
                    break     # everything after this is generation, which is
                              # not what this measures
    except urllib.error.HTTPError as e:
        out["error"] = f"HTTP {e.code}"
    except Exception as e:  # noqa: BLE001
        out["error"] = f"{type(e).__name__}: {e}"
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--token-file", required=True)
    ap.add_argument("--origin", default="https://splex-ai.vercel.app")
    ap.add_argument("--timeout", type=int, default=90)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    token = Path(args.token_file).read_text().strip()
    rows = []
    print(f"{'expected path':<12} {'ms':>7}  {'routed to':<22} message")
    for expected, message in PROBES:
        r = time_to_decision(args.base_url, token, args.origin, message, args.timeout)
        # The reason string states which path the server actually took, so
        # the grouping is the server's own account of itself, not our guess.
        reason = (r.get("reason") or "").lower()
        actual = "keyword" if "keyword" in reason or "contextual" in reason else "classifier"
        rows.append({**r, "expected": expected, "actual": actual, "message": message})
        print(f"{actual:<12} {str(r['decision_ms'] or '-'):>7}  "
              f"{str(r['label'] or r['error'] or '-'):<22} {message[:44]}")
        time.sleep(1)

    kw = [r["decision_ms"] for r in rows if r["actual"] == "keyword" and r["decision_ms"]]
    llm = [r["decision_ms"] for r in rows if r["actual"] == "classifier" and r["decision_ms"]]
    report = {
        "n_keyword": len(kw), "n_classifier": len(llm),
        "median_keyword_ms": statistics.median(kw) if kw else None,
        "median_classifier_ms": statistics.median(llm) if llm else None,
        "delta_ms": (statistics.median(llm) - statistics.median(kw)) if kw and llm else None,
        "rows": rows,
    }
    print()
    if kw:
        print(f"median time to decision, keyword path    : {report['median_keyword_ms']} ms  (n={len(kw)})")
    if llm:
        print(f"median time to decision, classifier path : {report['median_classifier_ms']} ms  (n={len(llm)})")
    if report["delta_ms"] is not None:
        print(f"cost of the classifier round-trip        : {report['delta_ms']} ms")

    if args.out:
        Path(args.out).write_text(json.dumps(report, indent=2))
        print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
