# SPLEX Free-Tier Benchmark (SFB) v1.0

**Status:** PRE-REGISTERED SPECIFICATION
**Written:** 2026-09-07, before any SFB result existed
**Supersedes:** SIB/SSB v1.0 as the *headline* measurement. SIB v1.0 remains
valid as what it was — a 2026-09-06 measurement of the pre-fix system.

---

## 0. What this benchmark is for

To determine how good SPLEX is **on the Free tier**, using only models a Free
user can actually reach. No paid or frontier model contributes to any headline
number. Premium models are inventoried separately, in §7, and are never mixed
in.

Two scores, because SPLEX is a platform over models and one number cannot say
both things:

| | Measures |
|---|---|
| **SFB-I** — Free-tier intelligence | quality of the answers a Free user receives |
| **SFB-S** — Free-tier system | behaviour of the platform around those answers |

---

## 1. Scope and eligibility

**Eligible models:** exactly those a Free request can reach —
`model_registry` rows with `variant='free' AND is_active AND
free_tier_allowed`. Verified live before each run
(`bench/harness/registry_audit.py`) and re-verified from the database after
each run against the model ids actually used.

**Ineligible, and excluded from every headline figure:** every `variant='paid'`
row, and any model not in the registry. A run that touches one is aborted, not
adjusted.

**Tier:** `plan_tier='free'`, asserted before the run starts and re-read from
the database rather than assumed.

---

## 2. The honest shape of "a large evaluation set"

The brief asks for thousands of tasks. Some dimensions can honestly be
thousands; one cannot, and conflating them would be the easiest way to make
this benchmark look bigger than it is.

**Can be thousands, honestly:**
- *Free/paid isolation.* The property under test — "a Free request is never
  offered a paid model" — needs no answer key and no labels, so any generated
  message is a valid probe. Generating more adds real power.
- *Reliability.* The automated suite is a fixed, growing population.
- *Charge correctness, safety guards, constraint detection.* Same reasoning.

**Cannot honestly be thousands right now — and why:**
- *Answer quality.* Every item costs one live generation. The production
  OpenRouter account holds **$0**, which caps free-model usage at **50
  requests/day**. A thousand-item run needs twenty days at that rate. The
  sample size is therefore reported as measured, with confidence intervals,
  and the exact unblock is named. It is not padded.
- *Routing accuracy.* n could be inflated by generating more labelled
  prompts, but the patterns under test were written in this same session, so
  prompts authored now are **not independent evidence**. The headline routing
  figure therefore stays on the 432-item corpus authored in a prior session,
  before any of these changes existed. Author-aware sets, if any, are reported
  separately and never merged.

Every reported figure carries its own n, and the report states which of the
three buckets above it came from.

---

## 3. SFB-I — Free-tier intelligence

Categories and weights, fixed here, before results.

| Category | Weight |
|---|---:|
| Mathematics | 14% |
| Reasoning | 14% |
| Coding | 12% |
| Knowledge / factuality | 12% |
| Instruction following | 10% |
| Hallucination resistance | 10% |
| Long context | 8% |
| Multilingual | 8% |
| Safety | 6% |
| Structured output | 6% |

Identical to SIB v1.0's weights, deliberately: changing the weighting at the
same moment as changing the system would make the before/after comparison
meaningless.

**Scoring.** `category = Σcredit / N_applicable × 100`, where applicable means
outcome ∈ {CORRECT, INCORRECT, PARTIAL, UNSAFE_REFUSAL_MISMATCH}. Provider
failures never enter an accuracy denominator. Rubric/refusal-quality items go
to a review bucket and are never silently counted correct. Overall is the
weighted mean over categories that produced at least one applicable item, with
the weight of unscored categories removed from the denominator.

**Sampling.** Stratified by the weights above, not by the corpus's own
distribution. Seed for this run: `sfb-v1.0` — **different from SIB v1.0's
`sib-v1.0`**, so the sample is genuinely fresh rather than a re-scoring of the
same items.

---

## 4. SFB-S — Free-tier system

| Category | Weight | Source bucket |
|---|---:|---|
| Routing accuracy | 20% | independent corpus, offline |
| Task success | 20% | live |
| Reliability | 15% | automated suite |
| Capability selection (strict routing) | 10% | independent corpus, offline |
| Failure recovery | 10% | live probes |
| Cost correctness | 10% | database, post-run |
| Latency | 10% | live |
| Free/paid isolation | 5% | large-n offline |

Latency bands (fixed in advance, unchanged from SSB v1.0): p50 ≤3s → 100,
≤6s → 85, ≤10s → 70, ≤20s → 50, ≤40s → 25, else 0.

---

## 5. Reliability and isolation targets

The brief sets 99.99% as an **aspirational** target for reliability-class
metrics and asks for honest accuracy on intelligence metrics. That split is
respected literally:

- Isolation and charge-correctness are **pass/fail properties**. They are
  reported at whatever rate is measured, with the n behind them. 100% on
  n=2,000 is stated as "100% (n=2,000, 95% CI lower bound 99.8%)" — a claim of
  99.99% requires ~10⁴ observations to be *statistically meaningful*, and that
  bound is reported rather than the aspiration.
- Intelligence scores are reported exactly as measured. No target applies.

---

## 6. Anti-gaming rules

1. **No tuning to benchmark items.** Routing patterns are written from
   ordinary usage, never from corpus strings. Where a corpus phrasing would
   have raised the score (the corpus writes "Give only the number" on many
   maths items; treating "number" as a maths keyword lifted strict routing),
   the tempting signal was **removed** and the lower score kept. Logged in §8.
2. **No post-hoc scoring changes to raise a score.** Scorer changes are logged
   as amendments with their trigger, and every target is re-scored with one
   scorer version.
3. **Weights are fixed above, before results.**
4. **Negative controls are mandatory.** The routing suite is ~half deliberate
   negatives; the constraint detector suite is 12 negatives to 16 positives. A
   change that improves a positive by breaking a negative fails.
5. **An unmeasurable category is `n/a`, never 0%**, and its weight leaves the
   denominator.

---

## 7. Premium models — inventoried, never counted

Reported in a separate section: which paid models the registry offers, their
categories, and their current reachability. As of 2026-09-06 every paid model
returns HTTP 402 (the account holds $0), so the paid tier is both untestable
and non-functional. That is reported as a finding about the product, and
contributes **nothing** to SFB-I or SFB-S.

---

## 8. Amendments

- **A1 (inherited from SIB v1.0):** notation normalisation in the scorer —
  Unicode superscripts and LaTeX. Proven in both directions; wrong answers stay
  wrong.
- **A2 (inherited):** two genuine scorer bugs fixed (`score_exact` did not
  normalise the gold; `_extract_numbers` could not read a fraction).
- **A3 (inherited):** cost correctness narrowed to what is externally
  measurable.
- **A4 (inherited):** routing measured offline via a simulator validated to
  reproduce live decisions exactly.
- **A5 (2026-09-07, this spec):** headline routing n is held at the 432-item
  inherited corpus rather than expanded, because prompts authored after the
  patterns are not independent evidence. This *lowers* the reportable n and is
  recorded so the choice is visible.
