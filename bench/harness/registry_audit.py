"""Audits model_registry against OpenRouter's live catalogue.

Uses the provider's `/models` listing rather than trial completions: it is
authoritative about whether a model id still exists, costs nothing, and does
not consume the free-model request quota — so this can run on every deploy
rather than only when something has already broken.

It answers two different questions and does not conflate them:
  - EXISTS: is the id still in the catalogue at all? A missing id is a
    guaranteed failure for every request routed to it.
  - PRICED FREE: does the catalogue still report $0 prompt/completion cost?
    A `:free` suffix is a naming convention, not a guarantee.
"""

from __future__ import annotations

import argparse
import json
import urllib.request
from pathlib import Path

from .provision import load_env

OR_MODELS = "https://openrouter.ai/api/v1/models"


def fetch_catalogue(key: str) -> dict[str, dict]:
    req = urllib.request.Request(OR_MODELS)
    req.add_header("Authorization", f"Bearer {key}")
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.loads(r.read())["data"]
    return {m["id"]: m for m in data}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--env-file", default=str(Path.home() / "Desktop/Splex/apps/backend/.env"))
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    env = load_env(Path(args.env_file))
    base, srk = env["SUPABASE_URL"].rstrip("/"), env["SUPABASE_SERVICE_ROLE_KEY"]

    req = urllib.request.Request(
        f"{base}/rest/v1/model_registry"
        "?select=id,category,variant,openrouter_model_id,is_active,free_tier_allowed,pro_tier_allowed,priority"
        "&is_active=eq.true&order=category,variant,priority")
    req.add_header("apikey", srk)
    req.add_header("Authorization", f"Bearer {srk}")
    with urllib.request.urlopen(req, timeout=60) as r:
        rows = json.loads(r.read())

    catalogue = fetch_catalogue(env["OPENROUTER_API_KEY"])
    print(f"registry active rows: {len(rows)}   OpenRouter catalogue: {len(catalogue)}\n")

    problems = []
    for row in rows:
        mid = row["openrouter_model_id"]
        entry = catalogue.get(mid)
        if entry is None:
            problems.append({**row, "issue": "MISSING_FROM_CATALOGUE"})
            continue
        pricing = entry.get("pricing") or {}
        try:
            is_free = float(pricing.get("prompt", "1")) == 0 and float(pricing.get("completion", "1")) == 0
        except (TypeError, ValueError):
            is_free = False
        if row["variant"] == "free" and not is_free:
            problems.append({**row, "issue": "VARIANT_FREE_BUT_PRICED"})
        if row["variant"] == "paid" and is_free:
            problems.append({**row, "issue": "VARIANT_PAID_BUT_FREE"})

    if not problems:
        print("no discrepancies — every active registry row exists and is priced as declared")
    for p in problems:
        print(f"  {p['issue']:<26} {p['category']:<12} {p['variant']:<5} "
              f"priority={p['priority']:<4} {p['openrouter_model_id']}")

    if args.out:
        Path(args.out).write_text(json.dumps(
            {"active_rows": len(rows), "catalogue": len(catalogue), "problems": problems}, indent=2))
        print(f"\nwrote {args.out}")
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
