# SPLEX Intelligence Benchmark (SIB) v1.0 & SPLEX System Benchmark (SSB) v1.0

**Status:** PRE-REGISTERED SPECIFICATION
**Written:** 2026-09-06, *before any benchmark result existed*
**Author:** automated evaluation pass
**Rule this document exists to enforce:** category weights, scoring rules and
inclusion criteria are fixed here, in advance. Any change made after results
are visible must be recorded in the "Amendments" section with its reason, and
both the pre- and post-amendment scores must be reported.

---

## 0. Why two benchmarks

SPLEX is not a model. It is a router plus an orchestration layer over a pool of
third-party models. Scoring it as if it were a single model would answer the
wrong question, and scoring only the platform would ignore that users judge it
by the quality of its answers.

| | Measures | Answers |
|---|---|---|
| **SIB v1.0** | Quality of the answers a user actually receives | "How smart is SPLEX?" |
| **SSB v1.0** | Behaviour of the platform around those answers | "How well does SPLEX work?" |

A model that answers well through a router that picks it wrongly half the time
scores well on SIB and badly on SSB. Both numbers are needed.

---

## 1. What is under test

**System under test (SUT):** SPLEX, driven exactly as a real user drives it —
one HTTP `POST /chat` per task against the deployed backend, authenticated as a
genuine account, reading the SSE stream to completion.

The harness **never selects a model.** Model choice is Cortex's job and is part
of what is being measured.

**Tier under test: Free.** This is not a preference. As of 2026-09-06 the
production OpenRouter account holds **zero purchased credits**, so every paid
model returns HTTP 402. The paid (Starter) tier is therefore *untestable and
also non-functional in production* — recorded as finding SEC/COST-1 rather
than worked around. Every SIB number in v1.0 is a **Free-tier** number and must
be labelled as such.

---

## 2. SIB v1.0 — categories and pre-registered weights

Weights reflect how much each capability contributes to a general-purpose
assistant's usefulness. They are set now, blind to results.

| # | Category | Weight | Primary source of items |
|---|---|---:|---|
| 1 | Mathematics | 14% | corpus: arithmetic, algebra, fractions, geometry, trigonometry, statistics, probability, unit conversion — answers computed by `sympy`/`Fraction` |
| 2 | Reasoning | 14% | corpus: logical_reasoning, adversarial_reasoning, physics (applied reasoning) |
| 3 | Coding | 12% | corpus: `PROGRAMMATIC` items executed against hidden tests |
| 4 | Knowledge / factuality | 12% | corpus: chemistry, biology, geography, history, astronomy, computer_science |
| 5 | Instruction following | 10% | corpus `STRUCTURE` items + SIB-EXT instruction items |
| 6 | Hallucination resistance | 10% | corpus: hallucination_resistance, current_information, ambiguity_handling |
| 7 | Long context | 8% | corpus long_context + SIB-EXT needle-in-haystack |
| 8 | Multilingual | 8% | SIB-EXT (new — corpus has none) |
| 9 | Safety | 6% | corpus: safety_refusal, adversarial_input |
| 10 | Structured output | 6% | corpus: structured_output, latex |

**Total: 100%.**

Categories in the original brief that are **not** in SIB and why:
- *Tool use, model routing, multimodal, document understanding, task
  completion, failure recovery, reliability, latency, cost efficiency* — these
  are platform properties, so they score under **SSB**, not SIB. Counting them
  twice would double-count.

### 2.1 Scoring a category

```
category_score = Σ(credit) / N_applicable × 100
```

- `credit` is 1 for CORRECT, the stated fraction for PARTIAL, 0 for INCORRECT.
- `N_applicable` counts only items whose outcome is in
  {CORRECT, INCORRECT, PARTIAL, UNSAFE_REFUSAL_MISMATCH}.
- **Provider failures are excluded from the denominator.** A 429 or a timeout
  is not a wrong answer. They are reported separately as an availability
  figure, which is an SSB concern.
- `NEEDS_REVIEW` items (rubric/refusal quality) are **excluded from the
  automatic score** and reported as their own bucket. They are never silently
  counted as correct.

### 2.2 Overall SIB score

```
SIB = Σ (category_score × weight) / Σ (weight of categories with ≥1 applicable item)
```

Renormalising over *scored* categories only. If a category yields zero
applicable items it is reported as `n/a` and its weight is removed from the
denominator — never treated as 0%, which would be a measurement artefact
masquerading as a capability failure.

---

## 3. SSB v1.0 — categories and pre-registered weights

| # | Category | Weight | Method |
|---|---|---:|---|
| 1 | Routing accuracy | 20% | Does Cortex pick the category a human labelled? Measured against the live registry + real classifier. |
| 2 | Task success (end-to-end) | 20% | Fraction of live requests that return a complete, non-error answer. |
| 3 | Reliability | 15% | Existing automated suite + failure-injection tests, pass rate. |
| 4 | Capability selection | 10% | Correct capability set derived per intent. |
| 5 | Failure recovery | 10% | Behaviour when a model 402s/429s/times out: does it fall back, degrade honestly, or break? |
| 6 | Cost efficiency | 10% | Credits charged vs. real provider cost; correctness of the charge. |
| 7 | Latency | 10% | Time-to-final-token distribution against a pre-set budget. |
| 8 | Safety / isolation | 5% | Free tier cannot reach paid models; content-safety guards hold. |

**Total: 100%.**

### 3.1 Latency scoring (pre-registered, so it cannot be tuned to the result)

| p50 time-to-done | Score |
|---|---:|
| ≤ 3 s | 100 |
| ≤ 6 s | 85 |
| ≤ 10 s | 70 |
| ≤ 20 s | 50 |
| ≤ 40 s | 25 |
| > 40 s | 0 |

### 3.2 Cost-efficiency scoring

Score = percentage of completed requests where the credits charged match
`computeRealCost()` within ±1 credit **and** no request was charged for a
failed generation. Overcharging a user for a failure is scored 0 for that
request regardless of the arithmetic.

---

## 4. Statistical treatment

- Every reported score carries **n** (applicable items).
- Binomial 95% confidence intervals via the **Wilson score interval**, which
  behaves correctly at small n and near 0%/100% where the normal approximation
  does not. This benchmark is small; the interval is not decoration.
- A difference between two systems is called **meaningful only if their 95%
  Wilson intervals do not overlap.** Any other difference is reported as
  "not separable at this sample size".
- Both difference measures are always reported and never conflated:
  - **percentage-point difference** = `A − B`
  - **relative difference** = `(A − B) / B × 100`

---

## 5. Comparison protocol (Phase 4)

Comparison systems receive **byte-identical prompts**, the same scorer, the
same tolerances, and the same run window.

Documented, uncontrollable differences:
1. SPLEX applies its own system prompt and may inject user/project context;
   baselines are called with **no system prompt**. This is a real difference in
   what is being compared and is stated with every comparative number.
2. SPLEX streams via SSE through a Cloudflare Worker; baselines are called
   directly. Latency comparisons therefore measure *the product*, not the model.
3. SPLEX may route different items to different models. That is the point of
   SPLEX, and is why the comparison is "platform vs. single model".

Every comparison names the **exact model id, provider, and evaluation date**.
No comparison is described as "vs. <company name>" — only "vs. <exact model id>".

---

## 6. Held-out set

`corpus.jsonl` was authored in a prior session and its items have never been
used to tune SPLEX: SPLEX's prompts, routing weights and model registry were
all written before it existed, and nothing in the repo reads it at runtime
(verified: no non-bench file imports anything from `bench/`).

**SIB-EXT** (multilingual, long-context, instruction-following) is authored in
this session and is used **only** for measurement. To keep a genuine held-out
set, SIB-EXT items are written *before* any live run and are not inspected
against SPLEX output before scoring.

---

## 7. Known limitations (declared in advance)

1. **Free tier only.** Says nothing about paid-tier quality.
2. **Small n.** Free-model daily quota caps the live run. Wide intervals.
3. **Corpus skew.** The inherited corpus is ~60% mathematics by capability.
   SIB's weighting corrects for this at the score level, but categories with
   few items keep wide intervals.
4. **Provenance.** Some knowledge answers are model-authored from stable
   textbook facts (marked in each record's `source`), not independently
   verified. Restricted to long-settled facts for that reason.
5. **Vision/multimodal is unverified.** No free model in the registry is
   confirmed to accept image input. Gated behind a probe; reported SKIPPED,
   never as a failure, if the probe fails.
6. **Rubric items are not auto-graded by a model.** Using an LLM to judge
   hallucination imports the failure mode into the measurement.

---

## 8. Amendments

*(Any change made after results were visible must be logged here.)*

**A1 — 2026-09-06 — Notation normalisation added to the scorer.**
*Trigger:* the first live run marked three answers INCORRECT that were
mathematically right and differed only in notation — `O(n²)` against a gold of
`O(n^2)`, and correct expressions wrapped in LaTeX display maths.
*Change:* `normalise_notation()` rewrites Unicode superscripts, `×`/`÷`/`−`,
and common LaTeX (`\frac`, `\times`, `\sqrt`, `$…$`, `\(…\)`) into one form,
applied to NUMERIC / EXACT / SYMBOLIC only. STRUCTURE and REFUSAL keep the raw
string, because their criteria are claims about the literal text.
*Why this is not tuning:* it encodes no knowledge of any question or of any
system's habits, and `test_normalisation.py` proves in both directions —
right answers in other notations now pass, and wrong answers stay wrong.
*Effect on comparability:* every target is re-scored by `rescore.py` with one
scorer version, and the number of outcomes the fix changed is reported.

**A2 — 2026-09-06 — Two scorer bugs fixed (pre-existing, found by A1's tests).**
1. `score_exact` normalised the response but not the gold, so any gold
   containing punctuation could never match: gold `O(n^2)` stayed `o(n^2)`
   while the response became `o n^2`. Correct answers were scored wrong.
2. `_extract_numbers` could not read a fraction, so `2/3` yielded `[2, 3]` and
   a correct fractional answer was scored as two wrong numbers.
Both fixes are symmetric across targets.

**A3 — 2026-09-06 — SSB §3.2 cost efficiency narrowed to what is measurable.**
The spec asked for credits-charged vs. a re-computed `computeRealCost()`. That
is not reproducible from outside the server: `messages` stores the resulting
charge but not the token counts the calculation consumed. Measured instead:
failed generations must cost nothing, completed generations must be billed,
and real provider spend for a Free-tier run must be $0. The narrower scope is
stated wherever the number appears.

**A4 — 2026-09-06 — Routing measured twice, at two sample sizes.**
The live run affords ~70 routing observations. Routing is deterministic up to
the LLM-fallback branch, so `route_sim.mjs` replays the production `INTENTS`
table over all 432 corpus items offline. It is used ONLY after
`route_validate.py` confirms exact agreement with every deterministic live
decision; items that reach the LLM fallback are excluded, never guessed.
