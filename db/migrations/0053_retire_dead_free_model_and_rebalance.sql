-- 0053 — retire a dead free model, and rebalance the free pools against
--        measured availability rather than curated guesses.
--
-- Evidence: SIB v1.0 / SSB v1.0, 2026-09-06..07 (bench/reports/).
--
-- WHY THIS IS A DATA MIGRATION AND NOT A CODE CHANGE
-- Cortex v1 — the version every Free user runs (cortex/version.ts) — does
-- NOT blend live model_health into its scores. That is deliberate and
-- documented in cortex/routing.ts: health blending is a v1.5 feature. The
-- consequence measured in production is that `reliability_score` and
-- `priority` in THIS table are the only signals a Free request responds to,
-- so correcting the pool means correcting the configured values here.
--
-- Every change below is reversible: nothing is deleted, rows are only
-- deactivated or re-prioritised.

begin;

-- 1. z-ai/glm-5.2:free no longer exists ------------------------------------
-- OpenRouter returns HTTP 404 for this id: "This model is unavailable for
-- free. The paid version is available now - use this slug instead:
-- z-ai/glm-5.2". Confirmed absent from the live /models catalogue
-- (bench/harness/registry_audit.py). It was already deactivated for coding,
-- general and math; these two rows were missed and were still being handed
-- to real Free requests as a candidate that can only ever fail.
update public.model_registry
   set is_active = false, updated_at = now()
 where openrouter_model_id = 'z-ai/glm-5.2:free'
   and is_active = true;

-- 2. Demote google/gemma-4-31b-it:free -------------------------------------
-- Returns HTTP 429 "temporarily rate-limited upstream" on a direct probe
-- made independently of SPLEX's own quota usage, and carries 0 successes
-- against 5 failures in model_health. It is still a capable model and still
-- exists, so it is kept as a fallback rather than removed — but it must not
-- be the FIRST candidate a Free user's request is spent on.
--
-- reliability_score is lowered as well as priority: priority only seeds the
-- candidate pool, while reliability_score is what v1's scorer actually
-- weighs. Changing one without the other would leave the model winning on
-- score after losing on order.
update public.model_registry
   set priority = 40,
       reliability_score = 35,
       updated_at = now()
 where openrouter_model_id = 'google/gemma-4-31b-it:free'
   and variant = 'free'
   and category in ('general', 'web_search');

-- Vision and documents keep gemma at its existing rank: it is one of only
-- two free candidates in each, and demoting it there would buy nothing.
-- The reliability signal still applies.
update public.model_registry
   set reliability_score = 45, updated_at = now()
 where openrouter_model_id = 'google/gemma-4-31b-it:free'
   and variant = 'free'
   and category in ('vision', 'documents');

-- 3. Promote the one free model with a real success record -----------------
-- minimax/minimax-m2.7:free served 57 of 62 answered benchmark requests
-- with zero failures, yet sat at priority 40 — last — in `general`, purely
-- because the curated ordering predated any live evidence.
update public.model_registry
   set priority = 10,
       reliability_score = 90,
       updated_at = now()
 where openrouter_model_id = 'minimax/minimax-m2.7:free'
   and variant = 'free'
   and category = 'general';

-- 4. Give web_search, writing and coding a candidate that works ------------
-- After (1), free web_search would have been left with only the throttled
-- gemma row. Free coding has two candidates and NEITHER has ever recorded a
-- success (cohere/north-mini-code:free 0/4, poolside/laguna-s-2.1:free 0/5)
-- — which is exactly what produced the 4 coding provider-failures in SIB
-- v1.0. A general model answering a coding question is a weaker route than
-- a specialist; it is a far better outcome than a guaranteed error, so it
-- is added as a LAST-resort candidate, never as the primary.
insert into public.model_registry
  (category, openrouter_model_id, variant, capability_score, context_length,
   cost_per_million_input, cost_per_million_output, is_active, priority,
   provider, modality, quality_score, latency_score, reliability_score,
   free_tier_allowed, pro_tier_allowed)
select v.category, 'minimax/minimax-m2.7:free', 'free', 72, 196608,
       0, 0, true, v.priority,
       'minimax', 'text', 72, 60, 90, true, false
  from (values ('web_search', 20), ('writing', 40), ('coding', 40)) as v(category, priority)
 where not exists (
   select 1 from public.model_registry r
    where r.category = v.category
      and r.variant = 'free'
      and r.openrouter_model_id = 'minimax/minimax-m2.7:free'
 );

-- 5. Reflect the measured failure record of two more free primaries --------
-- Both are ranked first in their category and have never recorded a
-- success. Their priority is deliberately NOT changed: unlike gemma, there
-- is no independent evidence (a clean upstream probe) separating a genuine
-- fault from this benchmark's own exhaustion of the shared free-model
-- quota, so only the confidence signal is adjusted, not the ordering.
-- Re-audit after a clean run before doing more.
update public.model_registry
   set reliability_score = 55, updated_at = now()
 where variant = 'free'
   and openrouter_model_id in (
     'cohere/north-mini-code:free',
     'google/gemma-4-26b-a4b-it:free'
   );

commit;
