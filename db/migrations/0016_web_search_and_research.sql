-- ============================================================================
-- SPLEX — Migration 0016: web search, deep research, real-time news
-- ============================================================================
-- Quota schedule grounded in real numbers, not invented:
--   - CREDITS_PER_USD = 25,000 (apps/backend/src/plugins/env.ts default) ->
--     1 credit = $0.00004.
--   - Free: 50,000 credits/month = $2.00 total budget, shared across every
--     capability. Pro: 1,000,000 credits/month = $40.00.
--   - OpenRouter's real web tool pricing (verified live against their
--     current docs/blog as of this migration): web_search ~$0.005/call
--     (10 results included), web_fetch ~$0.001/call. A single grounded
--     search-and-answer turn (1 search + modest completion tokens) costs
--     roughly $0.01-0.02 in practice.
--
-- Same "extra guardrail on top of the shared credit pool" pattern as every
-- other metered capability added this project (image/audio/video/ppt in
-- 0012/0013/0015): the daily counters below exist to bound BURST usage
-- independent of the pool, not to be the primary economic control — the
-- pool (checked via the existing check_credits/consume_credits path on
-- every call, unchanged) is what actually prevents overspend, since e.g.
-- Free's 10/day cap x 30 days x ~$0.015/call (~$4.50/month) already
-- exceeds Free's entire $2/month pool on its own if fully used — the pool
-- binds first, exactly as intended.
alter type counter_type add value if not exists 'web_searches';
alter type counter_type add value if not exists 'deep_research';
alter type counter_type add value if not exists 'research_max_searches';
alter type counter_type add value if not exists 'research_max_pages';
alter type counter_type add value if not exists 'research_cost';

-- Enum additions must commit before any statement below can reference the
-- new values — see migration 0012's PART A for the exact failure (55P04)
-- this avoids; not repeating that mistake here.
commit;

insert into public.plan_limits (plan_tier, counter_type, limit_amount) values
  -- Ordinary web search: available to both plans (spec requirement).
  -- News shares this same counter — it's a presentation distinction in
  -- the UI/intent classification, not a separate quota dimension (spec
  -- section 6: "news search: allowed within web-search quota").
  ('free', 'web_searches', 10),
  ('pro',  'web_searches', 100),

  -- Deep research: Pro-only. Free explicitly gets 0, which
  -- entitlements/index.ts's existing "limit 0 -> allowed:false" path
  -- already turns into a clear entitlement rejection rather than a vague
  -- failure — no new code path needed for that half of the requirement.
  ('free', 'deep_research', 0),
  ('pro',  'deep_research', 3),

  -- Per-TASK ceilings, not daily accumulators — same modeling as
  -- workflow_steps/workflow_cost in migration 0011 (that migration's own
  -- comment: "per-run caps, not accumulating usage"). Free gets no rows
  -- here at all: deep_research=0 already makes these unreachable for Free,
  -- and a row that can never be read is better left absent than set to a
  -- value implying the feature almost works.
  ('pro', 'research_max_searches', 6),   -- max search rounds/sub-questions the planner may schedule
  ('pro', 'research_max_pages', 8),      -- max URLs fetched for evidence in the "reading sources" stage
  ('pro', 'research_cost', 6000)         -- hard credit ceiling per research run (~$0.24) -- see research/deepResearch.ts's in-flight abort check
on conflict (plan_tier, counter_type) do update set limit_amount = excluded.limit_amount;

-- category='web_search' rows. Genuinely available to Free (unlike
-- image/audio/video/ppt), so — unlike those — this DOES get a real 'free'
-- variant row, reusing google/gemma-4-31b-it:free: already the live,
-- verified-working 'general' free model in this exact registry (migration
-- 0002), not a fresh unverified pick. 'paid' is google/gemini-3.6-flash —
-- verified live against the current catalog as of this migration; cheap,
-- well-known provider, explicitly positioned for agentic/tool-use
-- workloads (reading and synthesizing search/fetch results is exactly
-- that shape). Both are ordinary chat models, not something
-- search-specific — OpenRouter's web_search/web_fetch tools work
-- consistently across any model (the provider executes the tool and
-- injects results; it isn't dependent on the underlying model's own
-- native function-calling), so no specialized model is required.
--
-- Deep research's Planning/Cross-checking/Writing stages deliberately do
-- NOT get their own category here — they reuse the EXISTING
-- general/reasoning/writing categories via the normal
-- selectModelCandidates() call, per the spec's explicit "reuse existing...
-- do not duplicate" instruction. Only the two stages that actually need
-- tool access (Searching, Reading sources) route through this new
-- category. See apps/backend/src/research/deepResearch.ts.
insert into public.model_registry (category, openrouter_model_id, variant, capability_score, context_length, cost_per_million_input, cost_per_million_output, is_active, priority)
select 'web_search', 'google/gemma-4-31b-it:free', 'free', 75, 262144, 0, 0, true, 10
where not exists (
  select 1 from public.model_registry where category = 'web_search' and openrouter_model_id = 'google/gemma-4-31b-it:free' and variant = 'free'
);

insert into public.model_registry (category, openrouter_model_id, variant, capability_score, context_length, cost_per_million_input, cost_per_million_output, is_active, priority)
select 'web_search', 'google/gemini-3.6-flash', 'paid', 84, 1000000, 0.00075, 0.00375, true, 10
where not exists (
  select 1 from public.model_registry where category = 'web_search' and openrouter_model_id = 'google/gemini-3.6-flash' and variant = 'paid'
);

commit;
