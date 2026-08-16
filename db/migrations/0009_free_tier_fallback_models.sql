-- The single free-tier model per category has no fallback when OpenRouter's
-- shared free pool rate-limits it (observed live, repeatedly, all session —
-- e.g. google/gemma-4-31b-it:free on "general"). Add a second, lower-
-- priority free-tier candidate per category from a DIFFERENT provider
-- (reduces the odds both are rate-limited by the same upstream pool at
-- once). Verified live against OpenRouter's current /models catalog before
-- inserting — same diligence as migration 0002. vision is intentionally
-- skipped: no second free model in the current catalog is confirmed
-- multimodal-capable, and a text-only fallback would fail differently
-- (and more confusingly) than a rate limit.
insert into model_registry (category, openrouter_model_id, variant, capability_score, context_length, cost_per_million_input, cost_per_million_output, is_active, priority)
values
  ('coding',    'openai/gpt-oss-20b:free',      'free', 78, 131072, 0, 0, true, 20),
  ('documents', 'openai/gpt-oss-20b:free',      'free', 65, 131072, 0, 0, true, 20),
  ('general',   'nvidia/nemotron-nano-9b-v2:free', 'free', 70, 128000, 0, 0, true, 20),
  ('math',      'openai/gpt-oss-20b:free',      'free', 75, 131072, 0, 0, true, 20),
  ('reasoning', 'poolside/laguna-s-2.1:free',   'free', 78, 262144, 0, 0, true, 20),
  ('writing',   'poolside/laguna-xs-2.1:free',  'free', 70, 262144, 0, 0, true, 20);
