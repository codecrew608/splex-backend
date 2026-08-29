# SPLEX free-model evaluation corpus and harness

Measures how accurately SPLEX answers questions **using only the free models
it currently has access to**. No paid OpenRouter credits are ever spent — that
is enforced in code, not by convention (see *Safety*).

```
bench/
  corpus/
    schema.py            record schema, validation, duplicate detection
    build.py             builds + validates + de-duplicates -> corpus.jsonl
    corpus.jsonl         GENERATED. Do not hand-edit; rebuild instead.
    generators/          question sources (see "Where answers come from")
  harness/
    free_models.py       audited free-model inventory + the paid-call guard
    test_safety.py       tests the guard itself
    sandbox.py           executes candidate code against hidden tests
    evaluate.py          scoring, one function per evaluation method
    runner.py            Phase 2 executor (NOT run during Phase 1)
  reports/               run output
```

Build and verify:

```bash
python3 -m bench.corpus.build       # refuses to emit an invalid corpus
python3 -m bench.harness.test_safety
```

## Where answers come from

Provenance varies, and it matters when reading results:

| Source | Items | Trust |
|---|---|---|
| Computed by sympy / exact rational arithmetic | most maths, all unit conversions | Highest — independent of anyone's recall |
| Executed against hidden tests | 11 coding items | Highest — pass/fail is mechanical |
| Derived from `model_registry` + `modelSelect.ts` | media/routing items | High — read from the live database |
| Authored from stable textbook facts | chemistry, biology, geography | **Lower — these are my own knowledge** |
| No answer key by design | time-sensitive research items | N/A — scored on epistemic honesty |

The fourth row is the weak one and is marked as such in every record's
`source` field. Those items are restricted to long-settled facts (atomic
numbers, Newton's laws, SI units) precisely because that is where the risk of
my being wrong is lowest. Anything time-sensitive or contested has **no answer
key at all** — see `capability.py`'s research probes, which check whether the
system admits it cannot verify rather than testing it against a value that
will rot.

## Safety: why no paid call can happen

Four independent layers, because one check is a single point of failure when
real money is involved:

1. **L1 — plan tier.** `assert_free_plan` refuses anything but `free`. A paid
   tier routes to paid candidates *by design*, so this is refused up front.
2. **L2 — registry drift.** Before any request, the live `model_registry` is
   compared against the audited snapshot in `free_models.py`. Any difference
   aborts the run: a snapshot that has silently drifted is worse than none.
3. **L3 — observed model.** Every model id the server actually reports is
   checked against the audited free list. The first non-free id aborts the
   **entire run**, not just that question. This verifies what happened, not
   what was supposed to happen.
4. **L4 — request ceiling.** A hard cap so a bug cannot loop.

The `:free` suffix alone is **not** accepted — an unaudited `:free` id is
refused too, since this benchmark has not verified its pricing or category.
`test_safety.py` proves each layer blocks, including the same-family traps
(`z-ai/glm-5.2` vs `z-ai/glm-5.2:free`).

## Scoring principles

**A provider failure is not a wrong answer.** A 429 or a timeout says nothing
about a model's ability. Those record as `provider_failure` and are excluded
from accuracy denominators — folding them in makes a throttled model look
stupid rather than rate-limited.

**Rubric and refusal items are not auto-graded by a model.** Using an LLM to
judge whether another LLM hallucinated imports the failure into the
measurement. Those return `needs_review` with the criteria attached and are
reported as their own bucket, never silently counted as correct.

**Numeric scoring is lenient about prose, strict about the value.** Prompts ask
for "only the number", but penalising *"The answer is 42."* would measure
formatting rather than arithmetic. Format compliance is measured separately by
the `STRUCTURE` items. Symbolic scoring accepts `3x^2` as well as `3*x**2`, for
the same reason.

## Known limitations

- **Size.** 340 questions across 102 groups, not the several thousand
  originally targeted. Every item is a distinct skill or trap with a verified
  or explicitly-sourced answer; reaching thousands would have meant numeric
  permutation of existing questions, which the brief rules out and which adds
  no information about model behaviour. This is a real shortfall, not a
  redefinition of the target — the gap is in hand-authored semantic items
  (hallucination, ambiguity, adversarial), which do not generate mechanically.
- **Vision is unverified.** The registry lists three free models under
  `category='vision'`, but nothing in the data establishes that they accept
  image *input*. `cap-vision-probe-00` is a gate: if it fails, every other
  vision question is reported as SKIPPED (capability absent), never as
  incorrect.
- **The sandbox is not a security boundary.** It is a subprocess with time and
  memory limits — isolation for robustness. It only ever runs code generated
  from this corpus, on a developer machine. Running untrusted third-party code
  would need a container or VM.
- **The scorer has residual gaps.** Unusual notation can still be marked wrong.
  `needs_review` is the safety net; a suspicious `incorrect` rate in one
  category should be checked against the raw responses before being believed.

## Phase 2 (not yet run)

```bash
python3 -m bench.harness.runner \
  --base-url "$SPLEX_BENCH_URL" \
  --registry-json live_registry.json \
  --confirm-live
```

Requires `SPLEX_BENCH_TOKEN` for a genuine **Free-tier** account, and a fresh
`model_registry` dump for the L2 drift check. Without `--confirm-live` it
refuses to start. Cortex chooses the model — the harness never selects one,
because model selection is part of what is being measured.
