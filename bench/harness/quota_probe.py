"""Measures the remaining free-tier request budget.

The live benchmark is bounded by two independent ceilings, and the smaller
one decides the sample size:

  1. SPLEX's own `plan_limits` for a Free user  (daily_requests)
  2. OpenRouter's free-model daily allowance for the production key

Neither can be assumed. This reads (1) from the database and probes (2) from
the provider's own rate-limit headers, so the sample is designed against
measured budget rather than a guess.
"""

from __future__ import annotations

import argparse
import json
import urllib.error
import urllib.request
from pathlib import Path

from .provision import load_env

OR_BASE = "https://openrouter.ai/api/v1"
PROBE_MODEL = "nvidia/nemotron-3-super-120b-a12b:free"


def probe_openrouter(key: str) -> None:
    body = json.dumps({
        "model": PROBE_MODEL,
        "messages": [{"role": "user", "content": "ok"}],
        "max_tokens": 1,
    }).encode()
    req = urllib.request.Request(f"{OR_BASE}/chat/completions", data=body, method="POST")
    req.add_header("Authorization", f"Bearer {key}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            status, headers = r.status, dict(r.headers)
    except urllib.error.HTTPError as e:
        status, headers = e.code, dict(e.headers)

    print(f"  probe call -> HTTP {status}")
    interesting = {k: v for k, v in headers.items()
                   if "ratelimit" in k.lower() or "retry" in k.lower()}
    if interesting:
        for k, v in sorted(interesting.items()):
            print(f"    {k}: {v}")
    else:
        print("    (provider returned no rate-limit headers)")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--env-file", default=str(Path.home() / "Desktop/Splex/apps/backend/.env"))
    ap.add_argument("--user-id", required=True, help="benchmark user id, for the SPLEX-side counter")
    args = ap.parse_args()

    env = load_env(Path(args.env_file))
    base, srk = env["SUPABASE_URL"].rstrip("/"), env["SUPABASE_SERVICE_ROLE_KEY"]

    def rest(path: str):
        req = urllib.request.Request(f"{base}/rest/v1/{path}")
        req.add_header("apikey", srk)
        req.add_header("Authorization", f"Bearer {srk}")
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())

    print("SPLEX free-tier limits (plan_limits):")
    for row in rest("plan_limits?plan_tier=eq.free&select=counter_type,limit_amount"):
        print(f"  {row['counter_type']:<28} {row['limit_amount']}")

    print(f"\nBenchmark user usage today (usage_counters):")
    used = rest(f"usage_counters?user_id=eq.{args.user_id}&select=counter_type,period_start,used")
    if not used:
        print("  (no counters yet)")
    for row in used:
        print(f"  {row['counter_type']:<28} used={row['used']}  period={row['period_start']}")

    print("\nOpenRouter free-model budget:")
    key_req = urllib.request.Request(f"{OR_BASE}/credits")
    key_req.add_header("Authorization", f"Bearer {env['OPENROUTER_API_KEY']}")
    with urllib.request.urlopen(key_req, timeout=30) as r:
        c = json.loads(r.read())["data"]
    print(f"  purchased credits: ${c['total_credits']}   lifetime usage: ${c['total_usage']:.4f}")
    probe_openrouter(env["OPENROUTER_API_KEY"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
