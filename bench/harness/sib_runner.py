"""SIB v1.0 executor — runs one sample against SPLEX or a baseline model.

One module drives both targets on purpose. If SPLEX and its comparators went
through separate code paths they could diverge in prompt text, timeout,
retry behaviour or scoring, and every comparative number would be suspect.
Here the ONLY difference between targets is the transport function; the
sample, the prompt bytes, the scorer and the tolerances are shared.

Results are appended to a JSONL file as they complete, so exhausting a free
quota mid-run costs the remaining items and nothing already earned.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, asdict, field
from pathlib import Path

from .evaluate import score, Score
from .free_models import DISTINCT_FREE_MODEL_IDS, PaidCallBlocked, assert_free_plan
from .sib import load_corpus, stratified_sample, sib_category, BENCHMARK_VERSION

USER_AGENT = "SPLEX-Benchmark/1.0 (SIB v1.0)"
OR_BASE = "https://openrouter.ai/api/v1/chat/completions"

# L4 — a hard ceiling no run may exceed, whatever the arguments say.
MAX_REQUESTS = 400


@dataclass
class Row:
    question_id: str
    sib_category: str
    corpus_category: str
    difficulty: str
    evaluation_method: str
    target: str
    outcome: str
    credit: float
    detail: str = ""
    latency_ms: int | None = None
    ttft_ms: int | None = None
    routed_display_name: str | None = None
    routed_category: str | None = None
    cortex_version: str | None = None
    routed_model_id: str | None = None      # baselines only; SPLEX never exposes it
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    cost_usd: float | None = None
    conversation_id: str | None = None
    message_id: str | None = None
    response_excerpt: str = ""
    review_criteria: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Transports
# ---------------------------------------------------------------------------

def _post(url: str, body: dict, headers: dict, timeout: int):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST")
    for k, v in headers.items():
        req.add_header(k, v)
    return urllib.request.urlopen(req, timeout=timeout)


def call_splex(prompt: str, cfg: dict, timeout: int) -> dict:
    """One real user turn: POST /chat, read the SSE stream to `done`."""
    started = time.monotonic()
    out: dict = {"text": "", "error": None, "ttft_ms": None}
    parts: list[str] = []
    try:
        resp = _post(
            f"{cfg['base_url'].rstrip('/')}/chat",
            {"message": prompt},
            {
                "Authorization": f"Bearer {cfg['token']}",
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
                # Both required by the deployed edge: a missing/!allowed Origin
                # and the default Python UA are each answered 403 before any
                # SPLEX code runs.
                "Origin": cfg["origin"],
                "User-Agent": USER_AGENT,
            },
            timeout,
        )
        event = None
        for raw in resp:
            line = raw.decode("utf-8", "replace").rstrip("\n")
            if not line:
                continue
            if line.startswith("event:"):
                event = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                payload = line.split(":", 1)[1].strip()
                try:
                    data = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                if event == "token":
                    if out["ttft_ms"] is None:
                        out["ttft_ms"] = int((time.monotonic() - started) * 1000)
                    parts.append(data.get("delta", ""))
                elif event == "conversation_created":
                    out["conversation_id"] = data.get("conversationId")
                elif event == "cortex_decision":
                    out["routed_category"] = data.get("categoryLabel")
                elif event == "error":
                    out["error"] = data.get("message", "error event")
                elif event == "done":
                    out["message_id"] = data.get("messageId")
                    out["conversation_id"] = data.get("conversationId", out.get("conversation_id"))
                    r = data.get("routing") or {}
                    out["routed_display_name"] = r.get("modelDisplayName")
                    out["routed_category"] = r.get("categoryLabel", out.get("routed_category"))
                    out["cortex_version"] = r.get("cortexVersion")
                    if data.get("blocked"):
                        out["error"] = out["error"] or "blocked"
    except urllib.error.HTTPError as e:
        out["error"] = f"HTTP {e.code}"
    except Exception as e:  # noqa: BLE001 — a transport failure is data here
        out["error"] = f"{type(e).__name__}: {e}"

    out["text"] = "".join(parts).strip()
    out["latency_ms"] = int((time.monotonic() - started) * 1000)
    return out


def call_openrouter(prompt: str, cfg: dict, timeout: int) -> dict:
    """A baseline model, called directly with NO system prompt.

    The absence of a system prompt is a real, documented asymmetry against
    SPLEX (which injects its own). It is left in deliberately: adding an
    invented system prompt would be a second uncontrolled variable, and
    SPLEX's prompt is part of what SPLEX is.
    """
    started = time.monotonic()
    out: dict = {"text": "", "error": None, "ttft_ms": None}
    try:
        resp = _post(
            OR_BASE,
            {"model": cfg["model"], "messages": [{"role": "user", "content": prompt}],
             "max_tokens": cfg.get("max_tokens", 1024)},
            {"Authorization": f"Bearer {cfg['api_key']}", "Content-Type": "application/json",
             "User-Agent": USER_AGENT, "HTTP-Referer": "https://splex-ai.vercel.app",
             "X-Title": "SPLEX Benchmark"},
            timeout,
        )
        body = json.loads(resp.read())
        if "error" in body:
            out["error"] = str(body["error"])[:200]
        else:
            choice = (body.get("choices") or [{}])[0]
            out["text"] = (choice.get("message", {}) or {}).get("content") or ""
            usage = body.get("usage") or {}
            out["prompt_tokens"] = usage.get("prompt_tokens")
            out["completion_tokens"] = usage.get("completion_tokens")
            out["cost_usd"] = usage.get("cost")
            out["routed_model_id"] = body.get("model") or cfg["model"]
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = json.loads(e.read()).get("error", {}).get("message", "")[:120]
        except Exception:  # noqa: BLE001
            pass
        out["error"] = f"HTTP {e.code} {detail}".strip()
    except Exception as e:  # noqa: BLE001
        out["error"] = f"{type(e).__name__}: {e}"

    out["text"] = (out["text"] or "").strip()
    out["latency_ms"] = int((time.monotonic() - started) * 1000)
    # A single non-streaming response: first token and last token coincide.
    out["ttft_ms"] = out["latency_ms"]
    return out


# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=f"{BENCHMARK_VERSION} executor")
    ap.add_argument("--target", required=True,
                    help="'splex' or 'or:<openrouter model id>'")
    ap.add_argument("--budget", type=int, default=70, help="number of sampled items")
    ap.add_argument("--seed", default="sib-v1.0")
    ap.add_argument("--timeout", type=int, default=150)
    ap.add_argument("--out", required=True, help="JSONL results file (appended)")
    ap.add_argument("--base-url", default=os.environ.get("SPLEX_BENCH_URL"))
    ap.add_argument("--token-file", default=None)
    ap.add_argument("--origin", default="https://splex-ai.vercel.app")
    ap.add_argument("--env-file", default=str(Path.home() / "Desktop/Splex/apps/backend/.env"))
    ap.add_argument("--sleep", type=float, default=1.0,
                    help="seconds between requests; keeps well under the 20 req/min free ceiling")
    ap.add_argument("--confirm-live", action="store_true", required=False)
    ap.add_argument("--dry-run", action="store_true",
                    help="print the sample composition and exit without making any call")
    args = ap.parse_args()

    if args.dry_run:
        rows_all = load_corpus()
        sample, quotas = stratified_sample(rows_all, args.budget, seed=args.seed)
        print(f"{BENCHMARK_VERSION} sample — budget={args.budget}, actual={len(sample)}")
        for q in quotas:
            print(f"  {q.category:<26} target={q.target:<3} available={q.available:<4} taken={q.taken}")
        methods: dict[str, int] = {}
        for q in sample:
            methods[q["evaluation_method"]] = methods.get(q["evaluation_method"], 0) + 1
        print("  evaluation methods:", dict(sorted(methods.items())))
        return 0

    if not args.confirm_live:
        print("Refusing to run without --confirm-live (this makes real provider calls).",
              file=sys.stderr)
        return 2

    rows_all = load_corpus()
    sample, quotas = stratified_sample(rows_all, args.budget, seed=args.seed)
    if len(sample) > MAX_REQUESTS:
        print(f"Refusing: sample of {len(sample)} exceeds hard ceiling {MAX_REQUESTS}.",
              file=sys.stderr)
        return 3

    # Target setup ---------------------------------------------------------
    if args.target == "splex":
        assert_free_plan("free")           # L1
        if not args.base_url or not args.token_file:
            print("--base-url and --token-file are required for target 'splex'.", file=sys.stderr)
            return 2
        cfg = {"base_url": args.base_url,
               "token": Path(args.token_file).read_text().strip(),
               "origin": args.origin}
        transport, target_label = call_splex, "splex"
    elif args.target.startswith("or:"):
        model = args.target[3:]
        # L3 applied up front for baselines: the harness names the model
        # itself here, so it must be an audited free id. SPLEX's own routing
        # is never constrained this way — choosing the model is its job.
        if model not in DISTINCT_FREE_MODEL_IDS and not model.endswith(":free"):
            raise PaidCallBlocked(
                f"BLOCKED: baseline {model!r} is not a :free model. "
                "No paid OpenRouter credits may be spent by this benchmark."
            )
        from .provision import load_env
        env = load_env(Path(args.env_file))
        cfg = {"model": model, "api_key": env["OPENROUTER_API_KEY"]}
        transport, target_label = call_openrouter, f"or:{model}"
    else:
        print(f"unknown target {args.target!r}", file=sys.stderr)
        return 2

    # Resume ---------------------------------------------------------------
    out_path = Path(args.out)
    done: set[str] = set()
    if out_path.exists():
        for line in out_path.read_text().splitlines():
            if line.strip():
                r = json.loads(line)
                if r.get("target") == target_label:
                    done.add(r["question_id"])
        if done:
            print(f"resuming: {len(done)} items already recorded for {target_label}")

    todo = [q for q in sample if q["question_id"] not in done]
    print(f"{BENCHMARK_VERSION} | target={target_label} | sample={len(sample)} | to run={len(todo)}")
    for q in quotas:
        print(f"  {q.category:<26} target={q.target:<3} available={q.available:<4} taken={q.taken}")

    # Execute --------------------------------------------------------------
    with out_path.open("a") as fh:
        for i, q in enumerate(todo, 1):
            res = transport(q["prompt"], cfg, args.timeout)
            s: Score = score(q, res["text"] or None, res["error"])
            row = Row(
                question_id=q["question_id"],
                sib_category=sib_category(q) or "?",
                corpus_category=q["category"],
                difficulty=q["difficulty"],
                evaluation_method=q["evaluation_method"],
                target=target_label,
                outcome=s.outcome,
                credit=s.credit,
                detail=s.detail[:300],
                latency_ms=res.get("latency_ms"),
                ttft_ms=res.get("ttft_ms"),
                routed_display_name=res.get("routed_display_name"),
                routed_category=res.get("routed_category"),
                cortex_version=res.get("cortex_version"),
                routed_model_id=res.get("routed_model_id"),
                prompt_tokens=res.get("prompt_tokens"),
                completion_tokens=res.get("completion_tokens"),
                cost_usd=res.get("cost_usd"),
                conversation_id=res.get("conversation_id"),
                message_id=res.get("message_id"),
                # Full text, not an excerpt. A truncated record cannot be
                # re-scored later, and re-scoring every target with one
                # scorer version is the only way a comparison stays fair
                # when the scorer is improved mid-benchmark.
                response_excerpt=(res["text"] or "")[:20000],
                review_criteria=s.criteria,
            )
            fh.write(json.dumps(asdict(row), ensure_ascii=False) + "\n")
            fh.flush()
            print(f"[{i}/{len(todo)}] {row.question_id:<28} {row.sib_category:<24} "
                  f"{row.outcome:<22} {row.latency_ms}ms")
            time.sleep(args.sleep)

    print(f"\nwrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
