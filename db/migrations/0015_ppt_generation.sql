-- ============================================================================
-- SPLEX — Migration 0015: presentation (PPTX) generation model
-- ============================================================================
-- Quotas already exist from 0012 (('free','ppt_generations',0),
-- ('pro','ppt_generations',2)) and generated_media already carries every
-- column this needs — so, like 0013, this migration only registers the
-- model. No enum changes; additive and idempotent.
--
-- Unlike image/audio/video, category='ppt' is NOT a media model: PPTX
-- files are assembled locally by pptxgenjs (apps/backend/src/ppt/build.ts).
-- What the model actually does is produce the slide *content* as
-- structured JSON, which is a plain text-completion task. So this row
-- points at a cheap text model, and its cost_per_million_* values are real
-- and load-bearing (billing for this kind is token-based via
-- computeRealCost, not per-call like the other media kinds).
--
-- Model choice follows the spec's "do not use expensive premium models
-- unnecessarily / choose the cheapest model capable of each subtask":
-- outlining and slide-bulleting is structured-extraction work, exactly
-- what the existing classifier/memory-extraction path already uses this
-- same class of model for. Priced per OpenRouter's current catalog.
--
-- Free tier gets no row at all: ppt_generations is 0 for free (Pro-only
-- capability in V1), so a variant='free' row would be structurally
-- unreachable — same reasoning as audio in 0012 and video in 0013.
insert into public.model_registry (
  category, openrouter_model_id, variant, capability_score, context_length,
  cost_per_million_input, cost_per_million_output, is_active, priority,
  provider, modality, quality_score, coding_score, reasoning_score,
  latency_score, reliability_score, free_tier_allowed, pro_tier_allowed
)
select 'ppt', 'openai/gpt-oss-20b', 'paid', 72, 131072,
       0.05, 0.20, true, 10,
       'openai', 'text', 72, 60, 70,
       60, 75, false, true
where not exists (
  select 1 from public.model_registry
  where category = 'ppt' and openrouter_model_id = 'openai/gpt-oss-20b' and variant = 'paid'
);
