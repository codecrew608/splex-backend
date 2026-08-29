-- 0031 — deactivate two free models that can never serve a SPLEX request.
--
-- EVIDENCE (live availability probe, 2026-08-29, direct OpenRouter call,
-- zero cost, recorded in bench/reports/):
--
--   thinkingmachines/inkling:free        -> HTTP 403
--   thinkingmachines/inkling-small:free  -> HTTP 403
--
--   "<model> is only available on agentic harnesses. Try plugging it into a
--    coding agent or productivity app listed on https://openrouter.ai/apps"
--
-- This is NOT rate limiting and NOT transient. OpenRouter restricts these
-- models to registered agentic-harness applications; a plain chat-completions
-- call from SPLEX is refused permanently, for every user, on every request.
--
-- Both rows are currently is_active + free_tier_allowed, so they occupy real
-- candidate slots:
--     vision    priority 30  thinkingmachines/inkling:free
--     documents priority 30  thinkingmachines/inkling-small:free
--
-- Free tier only receives 2 candidates (Cortex v1), so today these sit just
-- out of reach — but Pro (v1.5, 3 candidates) reaches them, and any health-
-- driven reordering could promote them into the Free window too. Either way
-- they are dead weight that displaces a model that would actually answer.
--
-- Deactivating rather than deleting: the row keeps its configuration and
-- history, and re-enabling is a one-line change if SPLEX is ever registered
-- as an OpenRouter app (which is what would make these models reachable).
--
-- Companion code change (already committed): a 403 now continues the model
-- fallback chain instead of aborting the request, so even an unnoticed
-- access-denied model can no longer kill a request that had working
-- alternatives behind it.

update public.model_registry
   set is_active = false
 where openrouter_model_id in (
         'thinkingmachines/inkling:free',
         'thinkingmachines/inkling-small:free'
       );

-- Verification — expect two rows, both is_active = false.
-- select openrouter_model_id, category, is_active, free_tier_allowed
--   from public.model_registry
--  where openrouter_model_id like 'thinkingmachines/%';

-- Post-change free-candidate counts per category. NOTE: this leaves
-- 'documents' and 'vision' with 2 free candidates each, which still covers
-- the Free tier's 2-candidate window.
-- select category, count(*) as free_candidates
--   from public.model_registry
--  where variant = 'free' and is_active and free_tier_allowed
--  group by category order by category;
