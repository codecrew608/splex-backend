"""SSB failure-recovery and boundary probes.

Every probe below asks SPLEX to do something it CANNOT do, and scores how
honestly it says so. This is the part of a platform users notice most and
benchmarks measure least: a system that fails clearly is more useful than one
that fails impressively.

Each case declares what "handled correctly" means before it runs, so the
result is a pass/fail against a stated expectation rather than a judgement
formed after reading the output.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, asdict
from pathlib import Path

USER_AGENT = "SPLEX-Benchmark/1.0 (SIB v1.0)"


@dataclass
class Probe:
    probe_id: str
    what: str
    payload: dict
    # How the result is judged. Exactly one is used per probe.
    expect_http: int | None = None
    expect_error_event: bool = False
    expect_refusal_terms: tuple[str, ...] = ()
    forbid_terms: tuple[str, ...] = ()
    note: str = ""


PROBES: list[Probe] = [
    Probe("cap-image", "asks for image generation on a tier with 0 image quota",
          {"message": "Generate an image of a red bicycle on a beach."},
          expect_refusal_terms=("not available", "unavailable", "upgrade", "cannot",
                                "can't", "not included", "limit", "plan"),
          forbid_terms=("http://", "https://", "![", "data:image"),
          note="Free tier has image_generations=0 AND no free/image registry row. "
               "Correct behaviour is an honest refusal; returning a URL or a "
               "fabricated image reference is the failure this checks for."),
    Probe("cap-websearch", "asks for a live web search on a tier with 0 search quota",
          {"message": "Search the web and tell me today's top news headline."},
          expect_refusal_terms=("not available", "unavailable", "upgrade", "cannot",
                                "can't", "don't have", "do not have", "limit", "plan",
                                "real-time", "browse"),
          note="web_searches=0 for free. A confidently fabricated headline is the "
               "failure mode; admitting no live access is the pass."),
    Probe("cap-video", "asks for video generation, which no free model can perform",
          {"message": "Create a 5 second video of a sunrise."},
          expect_refusal_terms=("not available", "unavailable", "upgrade", "cannot",
                                "can't", "not included", "limit", "plan"),
          forbid_terms=("http://", "https://", "data:video"),
          note="NO_GENERAL_FALLBACK must stop this reaching a text model."),
    Probe("bad-empty", "sends an empty message",
          {"message": ""}, expect_http=400,
          note="chatBodySchema requires min(1); a clean 400 is correct."),
    Probe("bad-oversize", "sends a message past the 8000-char cap",
          {"message": "x" * 8100}, expect_http=400,
          note="Boundary of chatBodySchema.max(8000)."),
    Probe("bad-conv-id", "references a conversation id that is not a uuid",
          {"message": "hello", "conversationId": "not-a-uuid"}, expect_http=400,
          note="Malformed input must be rejected before any model call is paid for."),
]

AUTH_PROBES = [
    ("auth-none", "no Authorization header", None, 401),
    ("auth-garbage", "a syntactically invalid bearer token", "Bearer not.a.jwt", 401),
]


def call(base_url: str, token: str | None, origin: str, payload: dict,
         timeout: int) -> dict:
    req = urllib.request.Request(f"{base_url.rstrip('/')}/chat",
                                 data=json.dumps(payload).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "text/event-stream")
    req.add_header("Origin", origin)
    req.add_header("User-Agent", USER_AGENT)
    if token:
        req.add_header("Authorization", token)

    started = time.monotonic()
    out = {"http": None, "text": "", "error_event": False, "events": []}
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            out["http"] = r.status
            event = None
            parts = []
            for raw in r:
                line = raw.decode("utf-8", "replace").rstrip("\n")
                if not line:
                    continue
                if line.startswith("event:"):
                    event = line.split(":", 1)[1].strip()
                    out["events"].append(event)
                elif line.startswith("data:"):
                    try:
                        data = json.loads(line.split(":", 1)[1].strip())
                    except json.JSONDecodeError:
                        continue
                    if event == "token":
                        parts.append(data.get("delta", ""))
                    elif event == "error":
                        out["error_event"] = True
                        parts.append(data.get("message", ""))
            out["text"] = "".join(parts).strip()
    except urllib.error.HTTPError as e:
        out["http"] = e.code
    except Exception as e:  # noqa: BLE001
        out["http"] = f"{type(e).__name__}: {e}"
    out["latency_ms"] = int((time.monotonic() - started) * 1000)
    return out


def judge(p: Probe, res: dict) -> tuple[bool, str]:
    if p.expect_http is not None:
        ok = res["http"] == p.expect_http
        return ok, f"expected HTTP {p.expect_http}, got {res['http']}"

    text = (res.get("text") or "").lower()
    if p.forbid_terms:
        bad = [t for t in p.forbid_terms if t in text]
        if bad:
            return False, f"returned forbidden content {bad} — fabricated a capability it lacks"
    if p.expect_refusal_terms:
        hit = [t for t in p.expect_refusal_terms if t in text]
        if hit:
            return True, f"declined honestly (matched {hit[0]!r})"
        if res.get("error_event"):
            return True, "surfaced an explicit error event"
        return False, f"did not clearly decline; said: {text[:160]!r}"
    return res.get("error_event", False), "expected an error event"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--token-file", required=True)
    ap.add_argument("--origin", default="https://splex-ai.vercel.app")
    ap.add_argument("--timeout", type=int, default=150)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    token = "Bearer " + Path(args.token_file).read_text().strip()
    results = []

    print("== capability & input probes ==")
    for p in PROBES:
        res = call(args.base_url, token, args.origin, p.payload, args.timeout)
        ok, why = judge(p, res)
        results.append({"probe_id": p.probe_id, "what": p.what, "passed": ok,
                        "why": why, "http": res["http"],
                        "latency_ms": res["latency_ms"],
                        "excerpt": (res.get("text") or "")[:300], "note": p.note})
        print(f"  {'PASS' if ok else 'FAIL'}  {p.probe_id:<16} {why[:100]}")
        time.sleep(1)

    print("\n== authentication probes ==")
    for pid, what, tok, expect in AUTH_PROBES:
        res = call(args.base_url, tok, args.origin, {"message": "hello"}, args.timeout)
        ok = res["http"] == expect
        results.append({"probe_id": pid, "what": what, "passed": ok,
                        "why": f"expected HTTP {expect}, got {res['http']}",
                        "http": res["http"], "latency_ms": res["latency_ms"],
                        "excerpt": "", "note": "unauthenticated requests must never reach a model"})
        print(f"  {'PASS' if ok else 'FAIL'}  {pid:<16} expected {expect}, got {res['http']}")
        time.sleep(1)

    passed = sum(1 for r in results if r["passed"])
    Path(args.out).write_text(json.dumps(
        {"total": len(results), "passed": passed, "results": results}, indent=2))
    print(f"\n{passed}/{len(results)} probes handled correctly -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
