"""Single live request against the real /chat endpoint.

Exists to answer, before any large run: does the path work at all, what does
the SSE stream actually contain, and how long does a real turn take. Prints
every event rather than only the answer, because the runner's routing and
cost capture depend on which fields are genuinely present on the wire.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

USER_AGENT = "SPLEX-Benchmark/1.0 (SIB v1.0)"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--token-file", required=True)
    ap.add_argument("--message", default="What is 17 * 23? Reply with only the number.")
    ap.add_argument("--timeout", type=int, default=120)
    ap.add_argument("--origin", default="https://splex-ai.vercel.app")
    args = ap.parse_args()

    token = Path(args.token_file).read_text().strip()
    body = json.dumps({"message": args.message}).encode()

    req = urllib.request.Request(f"{args.base_url.rstrip('/')}/chat", data=body, method="POST")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "text/event-stream")
    # Required. Without an allowed Origin the deployed Worker answers 403
    # before any route runs, so a benchmark that omitted it would measure
    # nothing but its own misconfiguration.
    req.add_header("Origin", args.origin)
    # Cloudflare in front of the Worker 403s the default "Python-urllib/x.y"
    # User-Agent before the request reaches any SPLEX code (verified: same
    # request with any other UA returns 200). Identifying honestly as the
    # benchmark passes; impersonating a browser is neither needed nor done.
    req.add_header("User-Agent", USER_AGENT)

    started = time.monotonic()
    first_token_at = None
    events: list[tuple[str, str]] = []
    text: list[str] = []

    try:
        with urllib.request.urlopen(req, timeout=args.timeout) as r:
            print(f"HTTP {r.status}")
            event = None
            for raw in r:
                line = raw.decode("utf-8", "replace").rstrip("\n")
                if not line:
                    continue
                if line.startswith("event:"):
                    event = line.split(":", 1)[1].strip()
                elif line.startswith("data:"):
                    payload = line.split(":", 1)[1].strip()
                    events.append((event or "?", payload))
                    if event == "token":
                        if first_token_at is None:
                            first_token_at = time.monotonic() - started
                        try:
                            text.append(json.loads(payload).get("delta", ""))
                        except json.JSONDecodeError:
                            pass
                    else:
                        print(f"  [{event}] {payload[:400]}")
    except Exception as e:  # noqa: BLE001 — transport failure is the result here
        print(f"TRANSPORT FAILURE: {type(e).__name__}: {e}", file=sys.stderr)
        return 1

    total = time.monotonic() - started
    print(f"\ntoken events: {sum(1 for e, _ in events if e == 'token')}")
    print(f"ttft: {first_token_at:.2f}s" if first_token_at else "ttft: (no tokens)")
    print(f"total: {total:.2f}s")
    print(f"answer: {''.join(text).strip()[:600]!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
