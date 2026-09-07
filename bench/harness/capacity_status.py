"""Live observability for OpenRouter free-model capacity admission control
(migration 0054).

Read-only. Answers the operational question this feature exists to make
answerable: today, right now, how much of the tracked capacity has actually
been used, per model and in aggregate, and how many users are how close to
their own fair-share cap. Run this before deciding whether to raise
OPENROUTER_FREE_DAILY_CAPACITY, and after, to confirm the change took effect.
"""

from __future__ import annotations

import argparse
import json
import urllib.request
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--env-file", default=str(Path.home() / "Desktop/Splex/apps/backend/.env"))
    args = ap.parse_args()

    env: dict[str, str] = {}
    for line in Path(args.env_file).read_text().splitlines():
        t = line.strip()
        if not t or t.startswith("#") or "=" not in t:
            continue
        k, v = t.split("=", 1)
        env[k.strip()] = v.strip().strip("\"'")

    base, srk = env["SUPABASE_URL"].rstrip("/"), env["SUPABASE_SERVICE_ROLE_KEY"]

    def rest(path: str):
        req = urllib.request.Request(f"{base}/rest/v1/{path}")
        req.add_header("apikey", srk)
        req.add_header("Authorization", f"Bearer {srk}")
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())

    print("=== per-model capacity used today (UTC) ===")
    rows = rest(
        "provider_free_model_capacity?select=model_id,period_start,used,updated_at"
        "&order=used.desc&limit=50"
    )
    if not rows:
        print("  (no rows yet — nothing has been admitted since this migration deployed)")
    for r in rows:
        print(f"  {r['model_id']:<52} used={r['used']:<6} period={r['period_start']}  updated={r['updated_at']}")

    print("\n=== per-user openrouter_free_requests usage today ===")
    rows = rest(
        "usage_counters?select=user_id,period_start,used"
        "&counter_type=eq.openrouter_free_requests&order=used.desc&limit=20"
    )
    if not rows:
        print("  (no rows yet)")
    for r in rows:
        print(f"  {r['user_id']}  used={r['used']:<4} period={r['period_start']}")

    print("\n=== current config (from the deployed worker's own vars) ===")
    print("  read via: wrangler tail, or the values in deploy/backend/wrangler.jsonc")
    print("  OPENROUTER_FREE_DAILY_CAPACITY / OPENROUTER_FREE_SAFETY_BUFFER_PCT / OPENROUTER_PER_USER_SHARE_PCT")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
