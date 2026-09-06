"""Re-scores recorded results with the CURRENT scorer.

The scorer was improved mid-benchmark (notation normalisation, plus two real
bugs in `score_exact` and `_extract_numbers`). Results produced before that
were scored by an older scorer, and comparing them against results scored by
the newer one would be comparing two different measurements.

This re-scores every stored response with one scorer version so every number
in the report comes from the same instrument. It reports what changed, so the
effect of the scorer fix is visible rather than folded silently into a score.

TRUNCATION: rows recorded before the runner stored full text hold at most 400
characters. A row whose stored text is exactly at that cap AND whose outcome
would still be INCORRECT is flagged `truncated_uncertain` rather than being
counted either way — the evidence needed to score it was never saved.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

from .evaluate import score
from .sib import load_corpus

OLD_EXCERPT_CAP = 400


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    corpus = {q["question_id"]: q for q in load_corpus()}
    rows = [json.loads(l) for l in Path(args.inp).read_text().splitlines() if l.strip()]

    changes: list[dict] = []
    uncertain: list[dict] = []
    out_rows = []

    for r in rows:
        q = corpus.get(r["question_id"])
        text = r.get("response_excerpt") or ""

        # Provider failures are not re-scored: there is no response to judge,
        # and re-running them through the scorer could only invent an outcome.
        if not q or r["outcome"] in ("PROVIDER_UNAVAILABLE", "TIMEOUT", "SPLEX_ERROR"):
            out_rows.append(r)
            continue

        s = score(q, text or None, None)
        new = dict(r)
        new["outcome_original"] = r["outcome"]
        new["credit_original"] = r["credit"]
        new["outcome"] = s.outcome
        new["credit"] = s.credit
        new["detail"] = s.detail[:300]

        if s.outcome != r["outcome"]:
            changes.append({"question_id": r["question_id"], "target": r["target"],
                            "from": r["outcome"], "to": s.outcome})
        if s.outcome == "INCORRECT" and len(text) >= OLD_EXCERPT_CAP:
            new["truncated_uncertain"] = True
            uncertain.append({"question_id": r["question_id"], "target": r["target"],
                              "chars": len(text)})
        out_rows.append(new)

    Path(args.out).write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in out_rows) + "\n")

    print(f"re-scored {len(out_rows)} rows with the current scorer")
    print(f"outcome changes: {len(changes)}")
    for c in changes:
        print(f"  {c['target']:<34} {c['question_id']:<26} {c['from']} -> {c['to']}")
    print(f"\nrows whose stored text hit the old {OLD_EXCERPT_CAP}-char cap and are "
          f"still INCORRECT (evidence incomplete): {len(uncertain)}")
    for u in uncertain:
        print(f"  {u['target']:<34} {u['question_id']}")
    print(f"\nfinal outcome mix: {dict(Counter(r['outcome'] for r in out_rows))}")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
