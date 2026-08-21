-- Live production-readiness testing (2026-08-21) reproduced, on the real
-- backend against real OpenRouter traffic, the exact failure mode migration
-- 0009 already documents and fixed for every other category: "web_search"
-- has exactly ONE free-tier model (google/gemma-4-31b-it:free, migration
-- 0016), so when OpenRouter's shared free pool rate-limits it, free-tier
-- web search has zero fallback candidates and the whole request fails
-- ("OpenRouter classifier request failed (429): ... temporarily
-- rate-limited upstream", observed live in this backend's own logs).
-- web_search didn't exist yet when 0009 added a second free-tier candidate
-- to every other category — this closes that gap the same way, reusing the
-- same already-proven model from a different provider (Nvidia, not
-- Google) so the two candidates don't share a rate-limit pool.
--
-- Verified live before inserting: a real chat/completions call to
-- nvidia/nemotron-nano-9b-v2:free with tools:[{type:"openrouter:web_search"}]
-- returned a correct, current, cited answer (real Bitcoin price + 5
-- url_citation annotations from Google Finance/CoinMarketCap/CoinGecko/
-- Binance/CoinGecko-mirror) — confirms the model actually supports the
-- web_search server tool, not just general chat.
insert into public.model_registry (category, openrouter_model_id, variant, capability_score, context_length, cost_per_million_input, cost_per_million_output, is_active, priority)
select 'web_search', 'nvidia/nemotron-nano-9b-v2:free', 'free', 70, 128000, 0, 0, true, 20
where not exists (
  select 1 from public.model_registry where category = 'web_search' and openrouter_model_id = 'nvidia/nemotron-nano-9b-v2:free' and variant = 'free'
);
