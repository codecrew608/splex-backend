"""Live observability for OpenRouter free-model capacity admission control
(migration 0054) AND the Groq fallback (migration 0056).

Read-only. Answers the operational question this feature exists to make
answerable: today, right now, how much of the tracked capacity has actually
been used, per model and in aggregate, and how many users are how close to
their own fair-share cap. Run this before deciding whether to raise
OPENROUTER_FREE_DAILY_CAPACITY (or GROQ_TOTAL_DAILY_CAPACITY), and after, to
confirm the change took effect.

The Groq section below answers the specific question the failover feature
needs answerable at all times: how much of Free-tier traffic today was
served by OpenRouter directly vs. failed over to Groq, and how close the
Groq fallback itself is to ITS OWN shared daily cap — the resource a
failover-of-a-failover would have nowhere left to fail over to.
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

    # Reproduces groq/capacity.ts's resolveTierBudget math exactly, so this
    # utilization %/warning is computed against the SAME numbers the live
    # admission gate actually enforces, not a guess. If that function's
    # formula ever changes, update this block to match — the two drifting
    # apart is worse than deleting this section, since a wrong "still fine"
    # reading is worse than no reading.
    total_cap = int(env.get("GROQ_TOTAL_DAILY_CAPACITY", "1000"))
    buffer_pct = float(env.get("GROQ_SAFETY_BUFFER_PCT", "20"))
    paid_share_pct = float(env.get("GROQ_PAID_SHARE_PCT", "35"))
    buffered_total = max(1, int(total_cap * (1 - buffer_pct / 100)))
    if buffered_total >= 2:
        raw_paid = int(buffered_total * (paid_share_pct / 100))
        paid_slice = min(max(raw_paid, 1), buffered_total - 1)
    else:
        paid_slice = min(int(buffered_total * (paid_share_pct / 100)), buffered_total)
    free_slice = buffered_total - paid_slice

    print(f"\n=== Groq fallback: configured tier budgets (from resolveTierBudget's own formula) ===")
    print(f"  buffered total : {buffered_total} / day  (real account limit {total_cap}, {buffer_pct:.0f}% safety buffer)")
    print(f"  Free slice     : {free_slice} / day")
    print(f"  Paid slice     : {paid_slice} / day")

    print("\n=== Groq fallback: per-model capacity used today (UTC) — tier-split, by bookkeeping key ===")
    rows = rest(
        "provider_groq_capacity?select=model_id,period_start,used,updated_at"
        "&order=used.desc&limit=50"
    )
    if not rows:
        print("  (no rows yet — Groq fallback has not served any request since this migration deployed)")
    # WARNING threshold below is deliberately conservative (80%, not 100%) —
    # the whole point of surfacing this is catching pressure BEFORE a real
    # user gets denied, not after. This is the concrete fix for "capacity
    # pressure is only ever discoverable via a manual SQL query" — still a
    # manual run, but now with an unmissable, self-interpreting warning
    # instead of a bare number the reader has to know how to judge.
    for r in rows:
        cap = paid_slice if r["model_id"].endswith("#paid-tier") else free_slice if r["model_id"].endswith("#free-tier") else None
        if cap:
            pct = 100 * r["used"] / cap
            flag = "  <-- WARNING: over 80% of today's slice used" if pct >= 80 else ""
            print(f"  {r['model_id']:<40} used={r['used']:<6} / {cap:<6} ({pct:5.1f}%)  updated={r['updated_at']}{flag}")
        else:
            print(f"  {r['model_id']:<52} used={r['used']:<6} period={r['period_start']}  updated={r['updated_at']}")

    print("\n=== Groq fallback: per-user usage today (both tiers share this counter_type; cross-reference users.plan_tier to split) ===")
    rows = rest(
        "usage_counters?select=user_id,period_start,used"
        "&counter_type=eq.groq_free_requests&order=used.desc&limit=20"
    )
    if not rows:
        print("  (no rows yet)")
    for r in rows:
        print(f"  {r['user_id']}  used={r['used']:<4} period={r['period_start']}")

    # Groq RELIABILITY (migration 0058) — genuinely different question from
    # everything above, which all answers "how much of our OWN configured
    # capacity is used". This answers "is Groq itself getting less
    # reliable" — the concrete mitigation for the fact that Groq's free
    # developer tier carries no contract or SLA. A rising failure rate here,
    # trending across days, is the earliest real signal that something
    # changed on Groq's side — see this before a user ever has to report it.
    print("\n=== Groq RELIABILITY (dispatch success/failure, last 14 days, by tier) ===")
    rows = rest(
        "groq_dispatch_outcomes?select=period_start,tier,success,failure,last_failure_at,last_failure_status,last_failure_body"
        "&order=period_start.desc&limit=28"
    )
    if not rows:
        print("  (no rows yet — no Groq dispatch has completed since migration 0058 deployed)")
    for r in rows:
        total = r["success"] + r["failure"]
        rate = 100 * r["success"] / total if total else 0.0
        flag = "  <-- WARNING: success rate below 90%" if total >= 5 and rate < 90 else ""
        print(f"  {r['period_start']}  {r['tier']:<5}  success={r['success']:<4} failure={r['failure']:<4} rate={rate:5.1f}%{flag}")
        if r.get("last_failure_at"):
            print(f"      last failure: {r['last_failure_at']}  status={r['last_failure_status']}  {str(r.get('last_failure_body') or '')[:120]!r}")

    print("\n=== current config (from the deployed worker's own vars) ===")
    print("  read via: wrangler tail, or the values in deploy/backend/wrangler.jsonc")
    print("  OPENROUTER_FREE_DAILY_CAPACITY / OPENROUTER_FREE_SAFETY_BUFFER_PCT / OPENROUTER_PER_USER_SHARE_PCT")
    print("  GROQ_API_KEY (secret, presence-only) / GROQ_TOTAL_DAILY_CAPACITY / GROQ_SAFETY_BUFFER_PCT / GROQ_PAID_SHARE_PCT / GROQ_PER_USER_SHARE_PCT / GROQ_PER_USER_SHARE_PCT_PAID")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
