"""SIB v1.0 / SSB v1.0 aggregation and report generation.

Reads only recorded results — it never calls a model, so a report can be
regenerated and re-checked without spending quota or changing a number.

Two rules this module exists to enforce mechanically:
  1. Provider failures never enter an accuracy denominator.
  2. Percentage-point and relative differences are computed together, by one
     function, and always printed together.
"""

from __future__ import annotations

import argparse
import json
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

from . import ssb
from .sib import (WEIGHTS, BENCHMARK_VERSION, wilson_interval, intervals_separate,
                  pp_and_relative, load_corpus)

ACCURACY_OUTCOMES = {"CORRECT", "INCORRECT", "PARTIAL", "UNSAFE_REFUSAL_MISMATCH"}
FAILURE_OUTCOMES = {"PROVIDER_UNAVAILABLE", "TIMEOUT", "SPLEX_ERROR"}


def load(path: Path) -> list[dict]:
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


# ---------------------------------------------------------------------------
# SIB
# ---------------------------------------------------------------------------

def sib_scores(rows: list[dict]) -> dict:
    by_cat: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_cat[r["sib_category"]].append(r)

    cats: dict[str, dict] = {}
    for cat in WEIGHTS:
        items = by_cat.get(cat, [])
        scored = [r for r in items if r["outcome"] in ACCURACY_OUTCOMES]
        credit = sum(r["credit"] for r in scored)
        n = len(scored)
        cats[cat] = {
            "n_sampled": len(items),
            "n_scored": n,
            "n_review": sum(1 for r in items if r["outcome"] == "NEEDS_REVIEW"),
            "n_failed": sum(1 for r in items if r["outcome"] in FAILURE_OUTCOMES),
            "credit": credit,
            "score": (credit / n * 100) if n else None,
            # Wilson needs an integer-ish success count; PARTIAL credit is
            # carried in the point estimate and rounded here only for the
            # interval, which is an approximation and is stated as such.
            "ci": wilson_interval(credit, n) if n else None,
        }

    num = den = 0.0
    for cat, w in WEIGHTS.items():
        s = cats[cat]["score"]
        if s is None:
            continue
        num += s * w
        den += w

    return {
        "categories": cats,
        "overall": (num / den) if den else None,
        "weight_covered": den,
        "n_total": len(rows),
        "n_scored": sum(c["n_scored"] for c in cats.values()),
        "n_review": sum(c["n_review"] for c in cats.values()),
        "n_failed": sum(c["n_failed"] for c in cats.values()),
    }


# ---------------------------------------------------------------------------
# Database join — the facts SSE deliberately does not expose
# ---------------------------------------------------------------------------

def db_join(env_file: Path, user_id: str) -> dict:
    """Reads the raw model ids and credits actually recorded for the
    benchmark user. The SSE stream shows only a friendly display name, so
    free/paid isolation cannot be verified from the stream alone."""
    from .provision import load_env
    env = load_env(env_file)
    base, srk = env["SUPABASE_URL"].rstrip("/"), env["SUPABASE_SERVICE_ROLE_KEY"]

    def rest(path: str):
        req = urllib.request.Request(f"{base}/rest/v1/{path}")
        req.add_header("apikey", srk)
        req.add_header("Authorization", f"Bearer {srk}")
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())

    projects = rest(f"projects?user_id=eq.{user_id}&select=id")
    if not projects:
        return {"messages": [], "models": [], "credits_total": 0}
    pids = ",".join(p["id"] for p in projects)
    convs = rest(f"conversations?project_id=in.({pids})&select=id")
    if not convs:
        return {"messages": [], "models": [], "credits_total": 0}

    msgs: list[dict] = []
    cids = [c["id"] for c in convs]
    for i in range(0, len(cids), 40):          # keep the URL a sane length
        chunk = ",".join(cids[i:i + 40])
        msgs += rest(
            f"messages?conversation_id=in.({chunk})"
            "&select=id,role,status,credits_charged,routed_model,created_at"
            "&order=created_at.desc&limit=1000")

    models = [m["routed_model"] for m in msgs if m.get("routed_model")]
    return {
        "messages": msgs,
        "models": models,
        "model_counts": dict(Counter(models).most_common()),
        "credits_total": sum(m.get("credits_charged") or 0 for m in msgs),
        "status_counts": dict(Counter(m.get("status") for m in msgs)),
    }


# ---------------------------------------------------------------------------
# Comparison
# ---------------------------------------------------------------------------

def compare(a_name: str, a: dict, b_name: str, b: dict) -> dict:
    """Overall and per-category comparison, always reporting both difference
    measures and whether the 95% intervals actually separate."""
    out = {"a": a_name, "b": b_name, "categories": {}}

    # A comparison against a target that produced NO scored items is not a
    # comparison. Treating its missing score as 0 would manufacture a
    # spectacular win out of an infrastructure failure — so it is refused
    # outright and the reason is carried in the report.
    if a["overall"] is None or b["overall"] is None or b["n_scored"] == 0:
        out["overall"] = {
            "a_score": a["overall"], "b_score": b["overall"],
            "a_n": a["n_scored"], "b_n": b["n_scored"],
            "percentage_point_diff": None, "relative_pct_diff": None,
            "comparable": False,
            "reason": (f"{b_name} produced {b['n_scored']} scored items "
                       f"({b['n_failed']} provider failures) — no comparison is possible."),
        }
        return out

    pp, rel = pp_and_relative(a["overall"], b["overall"])
    out["overall"] = {
        "a_score": a["overall"], "b_score": b["overall"],
        "a_n": a["n_scored"], "b_n": b["n_scored"],
        "percentage_point_diff": pp, "relative_pct_diff": rel,
        "comparable": True,
    }
    for cat in WEIGHTS:
        ca, cb = a["categories"][cat], b["categories"][cat]
        if ca["score"] is None or cb["score"] is None:
            continue
        pp_c, rel_c = pp_and_relative(ca["score"], cb["score"])
        out["categories"][cat] = {
            "a_score": ca["score"], "a_n": ca["n_scored"], "a_ci": ca["ci"],
            "b_score": cb["score"], "b_n": cb["n_scored"], "b_ci": cb["ci"],
            "percentage_point_diff": pp_c, "relative_pct_diff": rel_c,
            "separable": intervals_separate(tuple(ca["ci"]), tuple(cb["ci"])),
        }
    return out


# ---------------------------------------------------------------------------

def fmt(v, suffix="%", places=1):
    return "n/a" if v is None else f"{v:.{places}f}{suffix}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", required=True, help="SIB results JSONL")
    ap.add_argument("--splex-target", default="splex")
    # The benchmark this run belongs to. Carried into the JSON and the
    # console header so an SFB result can never be read as an SIB one —
    # the two have different scopes and different samples, and mixing them
    # is exactly the confusion the spec forbids.
    ap.add_argument("--intelligence-label", default=BENCHMARK_VERSION)
    ap.add_argument("--system-label", default=ssb.BENCHMARK_VERSION)
    ap.add_argument("--baselines", nargs="*", default=[])
    ap.add_argument("--failure-probes", default=None)
    ap.add_argument("--vitest-json", default=None)
    ap.add_argument("--user-id", default=None)
    ap.add_argument("--env-file", default=str(Path.home() / "Desktop/Splex/apps/backend/.env"))
    ap.add_argument("--out-json", required=True)
    ap.add_argument("--isolation-json", default=None,
                    help="large-n free/paid isolation result (isolation_suite.mjs)")
    ap.add_argument("--or-usage-delta", type=float, default=None,
                    help="OpenRouter lifetime-usage delta across the run, in USD")
    args = ap.parse_args()

    all_rows = load(Path(args.results))
    corpus = {q["question_id"]: q for q in load_corpus()}

    splex_rows = [r for r in all_rows if r["target"] == args.splex_target]
    splex = sib_scores(splex_rows)

    baselines = {}
    for b in args.baselines:
        rows = [r for r in all_rows if r["target"] == b]
        if rows:
            baselines[b] = {"rows": rows, "scores": sib_scores(rows)}

    # ---- SSB -------------------------------------------------------------
    routing = ssb.routing_accuracy(splex_rows, corpus)
    success = ssb.task_success(splex_rows)
    lat = ssb.latency_stats(splex_rows)

    reliability = None
    if args.vitest_json and Path(args.vitest_json).exists():
        v = json.loads(Path(args.vitest_json).read_text())
        tot, ok = v.get("numTotalTests", 0), v.get("numPassedTests", 0)
        reliability = (ok / tot * 100) if tot else None

    failure_recovery = None
    probes = None
    if args.failure_probes and Path(args.failure_probes).exists():
        probes = json.loads(Path(args.failure_probes).read_text())
        failure_recovery = probes["passed"] / probes["total"] * 100 if probes["total"] else None

    db = {}
    isolation = {"pct": None, "violations": [], "distinct_models_used": []}
    cost = {"pct": None}
    if args.user_id:
        db = db_join(Path(args.env_file), args.user_id)
        isolation = ssb.safety_isolation(db.get("models", []))
        cost = ssb.cost_efficiency(db, args.or_usage_delta)

    # Isolation prefers the large-n suite when one was run. The run's own DB
    # models cover only the handful of models this sample happened to touch;
    # the suite exercises the real selector thousands of times across every
    # category, which is the difference between "no violation seen" and a
    # figure with a usable confidence bound.
    isolation_large = None
    if args.isolation_json and Path(args.isolation_json).exists():
        isolation_large = json.loads(Path(args.isolation_json).read_text())
        n = isolation_large["selector_invocations"]
        v = isolation_large["violations"]
        lo, _hi = wilson_interval(n - v, n)
        isolation_large["wilson_lower_pct"] = lo
        # Rule of three: with zero observed failures the 95% upper bound on
        # the failure rate is 3/n. This is what a "99.99%" claim would have
        # to clear, and it is reported whether or not it does.
        isolation_large["rule_of_three_upper_failure_pct"] = (3 / n * 100) if v == 0 else None
        isolation["pct"] = isolation_large["isolation_pct"]
        isolation["large_n"] = isolation_large

    ssb_components = {
        "routing_accuracy": routing["acceptable_pct"],
        "task_success": success["pct"],
        "reliability": reliability,
        "capability_selection": routing["strict_pct"],
        "failure_recovery": failure_recovery,
        "cost_efficiency": cost["pct"],
        "latency": lat.get("score"),
        "safety_isolation": isolation["pct"],
    }
    ssb_overall, ssb_weight = ssb.overall(ssb_components)

    report = {
        "benchmark": args.intelligence_label,
        "system_benchmark": args.system_label,
        "sib": {"splex": splex,
                "baselines": {k: v["scores"] for k, v in baselines.items()}},
        "ssb": {"components": ssb_components, "overall": ssb_overall,
                "weight_covered": ssb_weight,
                "routing_detail": routing, "task_success_detail": success,
                "latency_detail": lat, "isolation_detail": isolation,
                "cost_detail": cost,
                "failure_probes": probes},
        "db": {k: v for k, v in db.items() if k != "messages"},
        "comparisons": {b: compare("splex", splex, b, v["scores"])
                        for b, v in baselines.items()},
    }
    Path(args.out_json).write_text(json.dumps(report, indent=2))

    # ---- console summary -------------------------------------------------
    print(f"\n{'=' * 74}\n{args.intelligence_label} — SPLEX (Free tier)\n{'=' * 74}")
    print(f"Overall: {fmt(splex['overall'])}   "
          f"(scored n={splex['n_scored']}, review={splex['n_review']}, "
          f"provider failures={splex['n_failed']}, weight covered={splex['weight_covered']:.2f})")
    print(f"\n{'category':<26}{'score':>9}{'n':>5}{'95% CI':>20}{'review':>8}{'fail':>6}")
    for cat, w in WEIGHTS.items():
        c = splex["categories"][cat]
        ci = f"[{c['ci'][0]:.0f}, {c['ci'][1]:.0f}]" if c["ci"] else "-"
        print(f"{cat:<26}{fmt(c['score']):>9}{c['n_scored']:>5}{ci:>20}"
              f"{c['n_review']:>8}{c['n_failed']:>6}")

    print(f"\n{'=' * 74}\n{args.system_label} — SPLEX platform\n{'=' * 74}")
    print(f"Overall: {fmt(ssb_overall)}   (weight covered={ssb_weight:.2f})")
    for k, w in ssb.WEIGHTS.items():
        print(f"  {k:<24} {fmt(ssb_components[k]):>9}   weight {w:.2f}")

    for b, comp in report["comparisons"].items():
        o = comp["overall"]
        print(f"\n--- SPLEX vs {b} ---")
        print(f"  SPLEX {fmt(o['a_score'])}   {b} {fmt(o['b_score'])}")
        if not o.get("comparable"):
            print(f"  NOT COMPARABLE — {o['reason']}")
            continue
        rel = o["relative_pct_diff"]
        print(f"  n: SPLEX={o['a_n']}  {b}={o['b_n']}")
        print(f"  percentage-point difference: {o['percentage_point_diff']:+.1f} pp")
        print(f"  relative difference:         "
              f"{'n/a' if rel is None else f'{rel:+.2f}%'}")
        sep = [c for c, d in comp["categories"].items() if d["separable"]]
        print(f"  categories where the 95% intervals separate: {sep or 'none'}")

    print(f"\nwrote {args.out_json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
