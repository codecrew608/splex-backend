-- 0057 — Backfills quality_score for active paid model_registry rows that
-- have carried NULL since they were inserted.
--
-- WHAT WAS FOUND
-- Every active row for 5 real, currently-routed paid models
-- (deepseek/deepseek-v4-flash-0731, deepseek/deepseek-v4-pro-0813,
-- z-ai/glm-5.2, nvidia/nemotron-3-ultra-550b-a55b, minimax/minimax-m3) plus
-- one single-category row (google/gemini-3.7-flash, active only for 'ppt')
-- has quality_score = NULL across every category it appears in — unlike
-- qwen/qwen-2.5-72b-instruct and qwen/qwen2.5-vl-72b-instruct, which both
-- carry a real value. routing.ts's scoring blends quality_score as one of
-- several weighted signals; a NULL there means Cortex's paid-tier routing
-- has been making decisions on incomplete input for these models since
-- they were added — not broken, but less precise than it could be.
--
-- HONESTY NOTE (same convention this repo's own bench/README.md already
-- states for its own textbook-fact corpus items: "these are my own
-- knowledge — lower trust than a computed or executed answer"): the values
-- below are Claude's own knowledge-based estimates of these named, real
-- model families' general capability, NOT measured or benchmarked numbers.
-- Anchored, where possible, against this same table's own pre-existing
-- coding_score/reasoning_score values for internal consistency (e.g.
-- z-ai/glm-5.2 already carries coding_score=92 and reasoning_score=92 —
-- its quality_score below is set to reflect that same standout tier, not
-- picked independently). Treat these as a reasonable prior to route on
-- until real production health/quality signal accumulates — NOT as a
-- substitute for actually benchmarking them, which bench/harness/sib_runner.py
-- could do directly against real paid traffic once real OpenRouter balance
-- exists.
--
-- Only ACTIVE rows are touched — an inactive row is dead weight for
-- routing either way, so backfilling it would be pointless.

update public.model_registry set quality_score = 78, updated_at = now()
where variant = 'paid' and is_active = true and openrouter_model_id = 'deepseek/deepseek-v4-flash-0731';

update public.model_registry set quality_score = 83, updated_at = now()
where variant = 'paid' and is_active = true and openrouter_model_id = 'deepseek/deepseek-v4-pro-0813';

update public.model_registry set quality_score = 90, updated_at = now()
where variant = 'paid' and is_active = true and openrouter_model_id = 'z-ai/glm-5.2';

update public.model_registry set quality_score = 88, updated_at = now()
where variant = 'paid' and is_active = true and openrouter_model_id = 'nvidia/nemotron-3-ultra-550b-a55b';

update public.model_registry set quality_score = 79, updated_at = now()
where variant = 'paid' and is_active = true and openrouter_model_id = 'minimax/minimax-m3';

update public.model_registry set quality_score = 76, updated_at = now()
where variant = 'paid' and is_active = true and openrouter_model_id = 'google/gemini-3.7-flash';
