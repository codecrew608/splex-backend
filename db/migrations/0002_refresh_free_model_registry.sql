-- ============================================================================
-- SPLEX — Migration 0002: refresh dead :free model_registry rows
-- ============================================================================
-- Discovered during first real end-to-end /chat test (2026-08-15): EVERY
-- :free row seeded in the original schema is dead. OpenRouter returned
-- 404 "This model is unavailable for free" for qwen/qwen3-coder:free, and
-- checking all 7 free rows against the live catalog
-- (https://openrouter.ai/api/v1/models) confirmed all 7 are gone — the
-- entire free tier was non-functional. This is exactly the risk the
-- original schema's own comments warned about ("VERIFY THESE BEFORE
-- LAUNCH... free lineup changes often").
--
-- All paid rows still resolve except one redundant fallback
-- (deepseek/deepseek-coder, paid, coding) — harmless today since
-- qwen/qwen3-coder's better priority always wins the tie-break, but it's
-- dead data, so it's deactivated here too rather than left to silently
-- 404 if qwen3-coder is ever deactivated.
--
-- New free-row picks are the closest current-catalog fit per category by
-- description/specialization, not necessarily the same model family as the
-- existing (working) paid row for that category — as of this migration,
-- OpenRouter's :free lineup has no Qwen/DeepSeek/Llama entries at all, so
-- family-matching free-to-paid isn't achievable right now. What matters
-- architecturally is preserved: each category has one working free row and
-- one working paid row, and Cortex's variant selection never crosses them.
--
-- Re-verify this list periodically — the same churn will happen again.
-- ============================================================================

update public.model_registry set
  openrouter_model_id = 'cohere/north-mini-code:free',
  capability_score = 82,
  context_length = 256000
where category = 'coding' and variant = 'free';

update public.model_registry set is_active = false
where category = 'coding' and variant = 'paid' and openrouter_model_id = 'deepseek/deepseek-coder';

update public.model_registry set
  openrouter_model_id = 'nvidia/nemotron-nano-12b-v2-vl:free',
  capability_score = 68,
  context_length = 128000
where category = 'documents' and variant = 'free';

update public.model_registry set
  openrouter_model_id = 'google/gemma-4-31b-it:free',
  capability_score = 75,
  context_length = 262144
where category = 'general' and variant = 'free';

update public.model_registry set
  openrouter_model_id = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  capability_score = 80,
  context_length = 256000
where category = 'math' and variant = 'free';

update public.model_registry set
  openrouter_model_id = 'nvidia/nemotron-3-super-120b-a12b:free',
  capability_score = 82,
  context_length = 262144
where category = 'reasoning' and variant = 'free';

update public.model_registry set
  openrouter_model_id = 'nvidia/nemotron-nano-12b-v2-vl:free',
  capability_score = 68,
  context_length = 128000
where category = 'vision' and variant = 'free';

update public.model_registry set
  openrouter_model_id = 'google/gemma-4-26b-a4b-it:free',
  capability_score = 74,
  context_length = 262144
where category = 'writing' and variant = 'free';
