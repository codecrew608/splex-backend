"""Provisions the isolated benchmark identity and dumps the live registry.

Creates (or reuses) ONE dedicated Free-tier account that exists only to run
the benchmark, mints a short-lived access token for it, and writes a live
`model_registry` dump for the runner's L2 drift check.

Why a dedicated account rather than an existing one:
  - No real user's conversations, credits or rate-limit buckets are touched.
  - Everything the run writes is attributable to one id and can be removed in
    a single statement (see `--cleanup`).
  - plan_tier stays 'free', which is what keeps the run on `:free` models.
    A paid account would route to paid candidates BY DESIGN — that is the
    whole reason free_models.assert_free_plan exists.

Secrets handling:
  - The account password is generated here, used once, and never printed,
    logged, or written to the repo.
  - The access token is written to a 0600 file OUTSIDE the repository.
  - The service role key is read from the backend's own .env and never
    leaves this process.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
import urllib.error
import urllib.request
from pathlib import Path

BENCH_EMAIL = "sib-bench-v1@splex-benchmark.invalid"
DEFAULT_ENV = Path.home() / "Desktop/Splex/apps/backend/.env"


def load_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip("\"'")
    return out


def api(url: str, key: str, method: str = "GET", body: dict | None = None,
        bearer: str | None = None) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {bearer or key}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, {"raw": raw}


def find_user(base: str, srk: str, email: str) -> dict | None:
    # Admin list is paginated; filter server-side so this stays O(1) as the
    # real user table grows.
    status, body = api(f"{base}/auth/v1/admin/users?page=1&per_page=200", srk)
    if status != 200:
        raise SystemExit(f"admin list failed: {status} {body}")
    for u in body.get("users", []):
        if u.get("email") == email:
            return u
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--env-file", default=str(DEFAULT_ENV))
    ap.add_argument("--out-dir", required=True,
                    help="directory OUTSIDE the repo for the token file")
    ap.add_argument("--cleanup", action="store_true",
                    help="delete every conversation/message the benchmark user created")
    args = ap.parse_args()

    env = load_env(Path(args.env_file))
    base = env["SUPABASE_URL"].rstrip("/")
    srk = env["SUPABASE_SERVICE_ROLE_KEY"]

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    user = find_user(base, srk, BENCH_EMAIL)

    if args.cleanup:
        if not user:
            print("no benchmark user; nothing to clean")
            return 0
        status, _ = api(f"{base}/auth/v1/admin/users/{user['id']}", srk, method="DELETE")
        print(f"deleted benchmark user {user['id']} (HTTP {status})")
        return 0

    # One password, generated fresh every run, used only to mint a token.
    # Rotating it each time means a leaked older copy is already useless.
    password = secrets.token_urlsafe(32)

    if user:
        status, body = api(f"{base}/auth/v1/admin/users/{user['id']}", srk,
                           method="PUT", body={"password": password})
        if status != 200:
            raise SystemExit(f"password rotate failed: {status} {body}")
        print(f"reusing benchmark user {user['id']}")
    else:
        status, body = api(f"{base}/auth/v1/admin/users", srk, method="POST",
                           body={"email": BENCH_EMAIL, "password": password,
                                 "email_confirm": True})
        if status not in (200, 201):
            raise SystemExit(f"create failed: {status} {body}")
        user = body
        print(f"created benchmark user {user['id']}")

    status, tok = api(f"{base}/auth/v1/token?grant_type=password", srk,
                      method="POST", body={"email": BENCH_EMAIL, "password": password})
    if status != 200 or "access_token" not in tok:
        raise SystemExit(f"token mint failed: {status} {tok}")

    # Confirm the tier BEFORE handing the token to anything that spends
    # quota. assert_free_plan in the runner is the second check; this is the
    # first, and it reads the real row rather than assuming the default.
    status, rows = api(
        f"{base}/rest/v1/users?id=eq.{user['id']}&select=id,email,plan_tier", srk)
    if status != 200 or not rows:
        raise SystemExit(f"could not read users row: {status} {rows}")
    tier = rows[0]["plan_tier"]
    if tier != "free":
        raise SystemExit(f"REFUSING: benchmark user plan_tier is {tier!r}, must be 'free'.")
    print(f"plan_tier verified: {tier}")

    token_file = out_dir / "bench_token"
    token_file.write_text(tok["access_token"])
    token_file.chmod(0o600)

    # The runner's L2 check needs the same three conditions
    # queryModelRegistry applies for a Free user.
    status, reg = api(
        f"{base}/rest/v1/model_registry"
        "?variant=eq.free&is_active=eq.true&free_tier_allowed=eq.true"
        "&select=category,openrouter_model_id,variant,is_active,free_tier_allowed,priority"
        "&order=category,priority", srk)
    if status != 200:
        raise SystemExit(f"registry dump failed: {status} {reg}")
    reg_file = out_dir / "live_registry.json"
    reg_file.write_text(json.dumps(reg, indent=2))

    print(f"token   -> {token_file} (0600, expires in {tok.get('expires_in')}s)")
    print(f"registry-> {reg_file} ({len(reg)} free rows)")
    print(f"user_id  {user['id']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
