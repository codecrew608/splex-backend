"""Free-model availability probe.

Answers one question: which of the audited :free models can actually serve a
request right now, and if not, why.

Deliberately calls OpenRouter DIRECTLY rather than going through SPLEX. This
is the opposite of the accuracy benchmark's rule (which must travel the real
Cortex path) and it is correct here for two reasons: availability is a
property of the provider, not of SPLEX's routing; and going direct keeps
SPLEX's credit accounting entirely untouched, so a diagnostic cannot mutate
production billing state.

SAFETY — this probe cannot spend paid credits:
  * every model id is checked against the audited free list before the call,
    by the same assert_free_model used everywhere else;
  * a non-free id raises and aborts the whole probe;
  * MAX_REQUESTS is a hard ceiling, enforced by a counter, not by trusting
    the loop bounds;
  * Stage 0 is metadata only (/auth/key) and makes ZERO model calls, so the
    account's limit state is established before any inference is attempted.

Run:
    python3 -m bench.harness.availability_probe            # stage 0 only
    python3 -m bench.harness.availability_probe --probe    # stage 0 + stage 1
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, asdict, field
from pathlib import Path

from .free_models import (
    FREE_MODELS, DISTINCT_FREE_MODEL_IDS, assert_free_model, PaidCallBlocked,
)

OPENROUTER = "https://openrouter.ai/api/v1"
REPORTS = Path(__file__).parent.parent / "reports"

# Hard ceiling. One request per DISTINCT free model, plus a little slack.
# Enforced by a live counter below, not by the loop's own bounds.
MAX_REQUESTS = 20

# The smallest useful prompt: enough to prove the model will generate, small
# enough that it consumes almost nothing if the account does have quota.
PROBE_PROMPT = "Reply with exactly one word: ok"
PROBE_MAX_TOKENS = 5
TIMEOUT_S = 45


@dataclass
class ProbeResult:
    model_id: str
    categories: list[str]
    http_status: int | None
    latency_ms: int
    usable: bool
    classification: str          # ok | rate_limited | unavailable | auth | timeout | other
    provider_message: str = ""
    content: str = ""


class RequestBudget:
    """Independent of loop structure — a bug in iteration cannot exceed this."""

    def __init__(self, ceiling: int) -> None:
        self.ceiling = ceiling
        self.used = 0

    def spend(self) -> None:
        if self.used >= self.ceiling:
            raise PaidCallBlocked(
                f"BLOCKED: request ceiling of {self.ceiling} reached. Stopping cleanly."
            )
        self.used += 1


def _read_key() -> str:
    """Read the key from the environment or the local .env. Never printed."""
    key = os.environ.get("OPENROUTER_API_KEY")
    if key:
        return key
    env = Path(__file__).parent.parent.parent / "apps" / "backend" / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("OPENROUTER_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("OPENROUTER_API_KEY not found in environment or apps/backend/.env")


def _post(path: str, key: str, payload: dict | None, timeout: int = TIMEOUT_S):
    """Returns (status, parsed_body_or_text, latency_ms). Never raises on HTTP error."""
    url = f"{OPENROUTER}{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url, data=data, method="POST" if data else "GET",
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            # OpenRouter attribution headers, same as the backend sends.
            "HTTP-Referer": "https://splex-ai.vercel.app",
            "X-Title": "SPLEX availability probe",
        },
    )
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode()
            ms = int((time.monotonic() - started) * 1000)
            try:
                return resp.status, json.loads(body), ms
            except json.JSONDecodeError:
                return resp.status, body, ms
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        ms = int((time.monotonic() - started) * 1000)
        try:
            return e.code, json.loads(body), ms
        except json.JSONDecodeError:
            return e.code, body, ms
    except Exception as e:  # timeouts, DNS, TLS
        ms = int((time.monotonic() - started) * 1000)
        return None, f"{type(e).__name__}: {e}", ms


def _redact(text: str) -> str:
    """Strip anything key-shaped before this reaches a log or a report."""
    return re.sub(r"sk-[A-Za-z0-9_\-]{8,}", "sk-***REDACTED***", str(text))


def stage0_account_state(key: str) -> dict:
    """Metadata only. ZERO model calls, zero cost, no quota consumed.

    /auth/key reports the key's rate limit and usage, which is what
    distinguishes an ACCOUNT-level free-tier cap from per-provider upstream
    congestion — the exact ambiguity the 429s leave open.
    """
    status, body, ms = _post("/auth/key", key, None)
    return {"http_status": status, "latency_ms": ms, "body": body}


def classify(status: int | None, body) -> tuple[str, str]:
    """Map a provider response to an availability classification.

    Note the separation the accuracy benchmark depends on: NONE of these are
    answer-quality outcomes. They are infrastructure results.
    """
    msg = ""
    if isinstance(body, dict):
        err = body.get("error") or {}
        msg = err.get("message") if isinstance(err, dict) else str(err)
        msg = msg or json.dumps(body)[:400]
    else:
        msg = str(body)[:400]
    msg = _redact(msg)

    if status is None:
        return "timeout", msg
    if status == 200:
        return "ok", ""
    if status == 429:
        return "rate_limited", msg
    if status in (401, 403):
        return "auth", msg
    if status == 404 or "No endpoints found" in msg:
        return "unavailable", msg
    if status == 402:
        return "payment_required", msg
    return "other", msg


def stage1_probe_models(key: str, budget: RequestBudget) -> list[ProbeResult]:
    by_model: dict[str, list[str]] = {}
    for m in FREE_MODELS:
        by_model.setdefault(m.model_id, []).append(m.category)

    results: list[ProbeResult] = []
    for model_id in DISTINCT_FREE_MODEL_IDS:
        # Independent Free-only enforcement — not trusting the caller or the
        # router. A paid id here aborts the entire probe.
        assert_free_model(model_id, context="availability probe")
        budget.spend()

        status, body, ms = _post("/chat/completions", key, {
            "model": model_id,
            "messages": [{"role": "user", "content": PROBE_PROMPT}],
            "max_tokens": PROBE_MAX_TOKENS,
        })
        cls, msg = classify(status, body)
        content = ""
        if cls == "ok" and isinstance(body, dict):
            try:
                content = (body["choices"][0]["message"]["content"] or "").strip()[:120]
            except Exception:
                content = ""

        r = ProbeResult(
            model_id=model_id, categories=sorted(set(by_model[model_id])),
            http_status=status, latency_ms=ms, usable=(cls == "ok"),
            classification=cls, provider_message=msg, content=content,
        )
        results.append(r)
        print(f"  {model_id:52} {str(status):>5}  {cls:16} {ms:>6}ms  {content[:20]}")
    return results


def summarise(results: list[ProbeResult]) -> dict:
    usable = {r.model_id for r in results if r.usable}
    per_cat: dict[str, dict] = {}
    for m in FREE_MODELS:
        c = per_cat.setdefault(m.category, {"candidates": [], "usable": []})
        if m.model_id not in c["candidates"]:
            c["candidates"].append(m.model_id)
        if m.model_id in usable and m.model_id not in c["usable"]:
            c["usable"].append(m.model_id)
    return {
        "usable_models": sorted(usable),
        "unusable_models": sorted({r.model_id for r in results if not r.usable}),
        "by_classification": {
            c: sorted({r.model_id for r in results if r.classification == c})
            for c in sorted({r.classification for r in results})
        },
        "categories_with_usable_model": sorted(k for k, v in per_cat.items() if v["usable"]),
        "categories_with_zero_usable": sorted(k for k, v in per_cat.items() if not v["usable"]),
        "per_category": per_cat,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--probe", action="store_true",
                    help="also run stage 1 (one tiny request per free model)")
    args = ap.parse_args()

    key = _read_key()
    budget = RequestBudget(MAX_REQUESTS)

    print("STAGE 0 — account metadata (zero model calls, zero cost)")
    s0 = stage0_account_state(key)
    print(json.dumps({k: _redact(v) if isinstance(v, str) else v
                      for k, v in s0.items()}, indent=2, default=str)[:1500])

    out: dict = {"stage0": s0}

    if args.probe:
        print(f"\nSTAGE 1 — probing {len(DISTINCT_FREE_MODEL_IDS)} free models "
              f"(ceiling {MAX_REQUESTS})")
        try:
            results = stage1_probe_models(key, budget)
        except PaidCallBlocked as e:
            print(f"\n*** PROBE ABORTED ***\n{e}", file=sys.stderr)
            return 4
        out["stage1"] = [asdict(r) for r in results]
        out["summary"] = summarise(results)
        print("\n" + json.dumps(out["summary"], indent=2))

    out["requests_used"] = budget.used
    REPORTS.mkdir(exist_ok=True)
    path = REPORTS / f"availability-{time.strftime('%Y%m%d-%H%M%S')}.json"
    path.write_text(_redact(json.dumps(out, indent=2, default=str)))
    print(f"\nrequests used: {budget.used}/{MAX_REQUESTS}")
    print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
