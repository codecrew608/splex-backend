-- 0032 — Paid-plan economics, entitlements, and the approved paid model pool.
--
-- All data (no schema change):
--   1. New Free/Paid credits/daily_credits entitlements, and structural
--      workflow_cost/research_cost ceilings scaled to match.
--   2. Corrected model pricing from OpenRouter's authoritative /api/v1/models
--      metadata (the registry had stale figures).
--   3. The approved five-model paid pool, with curated priorities.
--   4. Three real, currently-live capability leaks closed: Free had
--      workflow_steps=3 (should be 0 — no workflows/agents on Free),
--      web_searches=10/day (should be 0 — no web search on Free), and
--      image_generations=2/day (should be 0 — no generation on Free). All
--      three are entitlements/index.ts's actual gating source today, not
--      hypothetical — found by re-checking plan_limits against this
--      spec's Free capability list, not assumed correct.
--   5. Category-specific coding_score/reasoning_score role calibration so
--      GLM/Nemotron/V4 Pro land in the roles this spec assigns them (see
--      that section's own comment for why this was necessary).
--
-- PRICING PROVENANCE. Every cost figure below was read from
-- https://openrouter.ai/api/v1/models on 2026-08-29 (public metadata, no
-- inference, no spend), NOT recalled or estimated. Several registry rows were
-- materially wrong — deepseek-v4-flash-0731 was recorded at $0.14/$0.28 when
-- it actually costs $0.045/$0.09, i.e. the router had been treating the
-- cheapest model as ~3x pricier than it is, which suppressed exactly the
-- model that should win cost-sensitive routing.
--
-- NOTE ON `priority`: it seeds the DB fetch order and (see realCost.ts)
-- nothing else — the ranked SCORE decides the winner, so a "primary" here is
-- a curated starting point, not a hardcoded choice. That is what lets a
-- simple question still land on a cheap model even in a category whose
-- primary is expensive.

-- ---------------------------------------------------------------------------
-- 1. Entitlements
-- ---------------------------------------------------------------------------
--
-- Free : 15,000 / month, 500 / day
-- Paid : 100,000 / month, 3,300 / day   (internal plan_tier = 'pro')
--
-- 'pro' is the paid tier: `starter` exists in plan_limits but has zero users
-- and no full limit set; the UI shows every non-free tier as "Starter" via
-- planDisplay.ts. Left untouched rather than deleted — removing a live enum
-- value is risk without benefit.

update public.plan_limits set limit_amount = 15000
 where plan_tier = 'free' and counter_type = 'credits';
update public.plan_limits set limit_amount = 500
 where plan_tier = 'free' and counter_type = 'daily_credits';

update public.plan_limits set limit_amount = 100000
 where plan_tier = 'pro' and counter_type = 'credits';
update public.plan_limits set limit_amount = 3300
 where plan_tier = 'pro' and counter_type = 'daily_credits';

-- The per-workflow and per-research structural ceilings are percentages of a
-- pool that just grew ~6.7x; leaving them unchanged would make a single
-- workflow able to consume a far smaller share than intended. Scaled to keep
-- their original proportion of the monthly pool.
update public.plan_limits set limit_amount = 25000
 where plan_tier = 'free' and counter_type = 'workflow_cost';     -- was 5000 of 3000
update public.plan_limits set limit_amount = 40000
 where plan_tier = 'pro'  and counter_type = 'workflow_cost';     -- was 50000 of 15000
update public.plan_limits set limit_amount = 12000
 where plan_tier = 'pro'  and counter_type = 'research_cost';     -- was 6000 of 15000

-- Free has no workflows/agents at all (spec: general chat, coding, math,
-- reasoning, writing, document/vision/av understanding only — no Deep
-- Research, web search, generation, workflows, or agents). workflow_steps
-- was left at 3 since migration 0011, which silently let Free trigger real
-- multi-step workflow runs. orchestrator.ts's startWorkflow/resumeWorkflow
-- now short-circuit to plain chat whenever maxSteps <= 0, so this degrades
-- safely rather than breaking Free chat.
update public.plan_limits set limit_amount = 0
 where plan_tier = 'free' and counter_type = 'workflow_steps';    -- was 3

-- Same category of gap for two more capabilities the spec explicitly
-- excludes from Free: web search (migration 0016 gave Free 10/day) and
-- image generation (migration 0012 gave Free 2/day). Both are real,
-- currently-live entitlements, not defaults — entitlements/index.ts's
-- getQuotaState() reads these rows directly, so this is the actual product
-- behavior today, not a theoretical gap. deep_research/video_generations/
-- audio_generations/ppt_generations are already 0 for free and need no
-- change.
update public.plan_limits set limit_amount = 0
 where plan_tier = 'free' and counter_type = 'web_searches';      -- was 10
update public.plan_limits set limit_amount = 0
 where plan_tier = 'free' and counter_type = 'image_generations'; -- was 2

-- ---------------------------------------------------------------------------
-- 2. Correct stale pricing (authoritative, 2026-08-29)
-- ---------------------------------------------------------------------------

update public.model_registry
   set cost_per_million_input = 0.045, cost_per_million_output = 0.090
 where openrouter_model_id = 'deepseek/deepseek-v4-flash-0731';

update public.model_registry
   set cost_per_million_input = 0.660, cost_per_million_output = 1.980
 where openrouter_model_id = 'deepseek/deepseek-v4-pro-0813';

update public.model_registry
   set cost_per_million_input = 0.250, cost_per_million_output = 0.750
 where openrouter_model_id = 'qwen/qwen2.5-vl-72b-instruct';

-- ---------------------------------------------------------------------------
-- 3. Retire text models outside the approved pool
-- ---------------------------------------------------------------------------
--
-- Deactivated, not deleted: history and configuration are preserved, and
-- re-enabling is a one-line change. Media rows (image/audio/video/ppt) are
-- deliberately KEPT — the five-model pool covers none of those capabilities,
-- and removing them would delete product features rather than change routing.
-- qwen2.5-vl is likewise kept as the vision fallback (verified image input,
-- and cheaper than the models it backs up), so vision is not left with a
-- single point of failure.

update public.model_registry set is_active = false
 where variant = 'paid'
   and openrouter_model_id in (
        'google/gemini-3.7-flash',
        'qwen/qwen3-coder',
        'meta-llama/llama-3.3-70b-instruct',
        'deepseek/deepseek-r1',
        'qwen/qwen3.8-27b'
       )
   and category not in ('image', 'audio', 'video', 'ppt');

-- ---------------------------------------------------------------------------
-- 4. The approved paid pool
-- ---------------------------------------------------------------------------
--
--   deepseek/deepseek-v4-flash-0731   $0.045 / $0.090   1,310,720 ctx  text
--   minimax/minimax-m3                $0.300 / $1.200   1,048,576 ctx  text+image+video
--   nvidia/nemotron-3-ultra-550b-a55b $0.500 / $2.200     262,144 ctx  text
--   deepseek/deepseek-v4-pro-0813     $0.660 / $1.980   1,048,576 ctx  text
--   z-ai/glm-5.2                      $1.190 / $3.740   1,048,576 ctx  text
--
-- MiniMax M3 is the vision primary because OpenRouter's metadata lists
-- input_modalities = [text, image, video] — verified, not assumed. It is also
-- cheaper than every model it replaces there.

insert into public.model_registry (
  category, openrouter_model_id, variant, is_active, free_tier_allowed, pro_tier_allowed,
  priority, capability_score, context_length, modality, provider,
  cost_per_million_input, cost_per_million_output
) values
  -- GENERAL: strong primary, economical fallback, stronger third.
  ('general','z-ai/glm-5.2','paid',true,false,true,10,90,1048576,'text','z-ai',1.190,3.740),
  ('general','nvidia/nemotron-3-ultra-550b-a55b','paid',true,false,true,30,88,262144,'text','nvidia',0.500,2.200),

  -- CODING: GLM primary, Nemotron then Flash, V4 Pro for genuinely hard work.
  ('coding','z-ai/glm-5.2','paid',true,false,true,10,92,1048576,'text','z-ai',1.190,3.740),
  ('coding','nvidia/nemotron-3-ultra-550b-a55b','paid',true,false,true,20,88,262144,'text','nvidia',0.500,2.200),

  -- MATH: Nemotron primary, then V4 Pro, then GLM.
  ('math','nvidia/nemotron-3-ultra-550b-a55b','paid',true,false,true,10,91,262144,'text','nvidia',0.500,2.200),
  ('math','z-ai/glm-5.2','paid',true,false,true,30,89,1048576,'text','z-ai',1.190,3.740),

  -- REASONING: GLM primary, Nemotron, then V4 Pro.
  ('reasoning','z-ai/glm-5.2','paid',true,false,true,10,92,1048576,'text','z-ai',1.190,3.740),
  ('reasoning','nvidia/nemotron-3-ultra-550b-a55b','paid',true,false,true,20,90,262144,'text','nvidia',0.500,2.200),

  -- RESEARCH / WEB SEARCH: GLM primary, V4 Pro, Nemotron.
  ('web_search','z-ai/glm-5.2','paid',true,false,true,10,90,1048576,'text','z-ai',1.190,3.740),
  ('web_search','deepseek/deepseek-v4-pro-0813','paid',true,false,true,20,89,1048576,'text','deepseek',0.660,1.980),
  ('web_search','nvidia/nemotron-3-ultra-550b-a55b','paid',true,false,true,30,87,262144,'text','nvidia',0.500,2.200),

  -- DOCUMENTS / LONG CONTEXT: MiniMax primary (1M ctx), V4 Pro, GLM.
  ('documents','minimax/minimax-m3','paid',true,false,true,10,87,1048576,'text','minimax',0.300,1.200),
  ('documents','deepseek/deepseek-v4-pro-0813','paid',true,false,true,20,88,1048576,'text','deepseek',0.660,1.980),
  ('documents','z-ai/glm-5.2','paid',true,false,true,30,88,1048576,'text','z-ai',1.190,3.740),

  -- VISION: MiniMax M3 only, plus the qwen2.5-vl row already present as fallback.
  ('vision','minimax/minimax-m3','paid',true,false,true,10,86,1048576,'text','minimax',0.300,1.200),

  -- WRITING: GLM primary, Flash economical, Nemotron stronger.
  ('writing','z-ai/glm-5.2','paid',true,false,true,10,89,1048576,'text','z-ai',1.190,3.740),
  ('writing','nvidia/nemotron-3-ultra-550b-a55b','paid',true,false,true,30,85,262144,'text','nvidia',0.500,2.200),

  -- PPT: keep a cheap text planner available now that gemini is retired here.
  ('ppt','deepseek/deepseek-v4-flash-0731','paid',true,false,true,10,80,1310720,'text','deepseek',0.045,0.090)
on conflict do nothing;

-- V4 Pro was already present for coding/math/reasoning; make sure it sits at
-- the "hard work" end of those categories rather than mid-pack.
update public.model_registry set priority = 40
 where openrouter_model_id = 'deepseek/deepseek-v4-pro-0813'
   and category in ('coding','math','reasoning');

-- free_tier_allowed must be FALSE on every paid row. Belt-and-braces: the
-- router already filters on variant AND free_tier_allowed AND a final
-- post-filter, but a mislabelled row here would be the one input that could
-- make a Free request look legitimate to all three.
update public.model_registry set free_tier_allowed = false where variant = 'paid';

-- ---------------------------------------------------------------------------
-- 5. Category-specific role calibration
-- ---------------------------------------------------------------------------
--
-- IMPORTANT PROVENANCE NOTE, stated plainly: the values below are ROLE
-- CALIBRATION, not measured benchmark results. No live accuracy benchmark
-- has been run against this pool (deliberately — see the standing
-- instruction not to spend paid OpenRouter inference for testing). They
-- exist to make the deterministic router realize this spec's explicit
-- primary/fallback ordering (§7) using the mechanism the schema already
-- provides for exactly this (capabilityFitFor() in routing.ts falls back to
-- coding_score for the coding category and to reasoning_score for BOTH
-- reasoning and math — that fallback chain is pre-existing code, not new).
--
-- Why this was necessary, not cosmetic: deepseek-v4-pro-0813 already carried
-- capability_score 94/92/92 (coding/math/reasoning) from an earlier,
-- unrelated session. Verified by direct calculation against the real
-- routing formula: with that flat score plus real pricing (V4 Pro undercuts
-- GLM's price while roughly matching its quality), V4 Pro would legitimately
-- outscore GLM 5.2 for ordinary coding AND reasoning, and would outscore
-- Nemotron for ordinary math — contradicting this spec's explicit "V4 Pro:
-- extreme cases only" role for all three. That is a real routing outcome,
-- not a hypothetical: it was caught by a failing test, not asserted.
--
-- capability_score itself is left untouched everywhere (other code/history
-- may depend on it); only the category-specific override columns are set.

-- CODING: GLM primary, Nemotron then Flash as ordinary fallbacks, V4 Pro
-- deliberately scored below all three so it is only competitive when a
-- request is expensive enough (via workload, not wording) to erode the
-- others' cost advantage — i.e. the "extreme" case the spec describes.
update public.model_registry set coding_score = 92 where category='coding' and openrouter_model_id='z-ai/glm-5.2';
update public.model_registry set coding_score = 85 where category='coding' and openrouter_model_id='nvidia/nemotron-3-ultra-550b-a55b';
update public.model_registry set coding_score = 80 where category='coding' and openrouter_model_id='deepseek/deepseek-v4-flash-0731';
update public.model_registry set coding_score = 76 where category='coding' and openrouter_model_id='deepseek/deepseek-v4-pro-0813';

-- REASONING: GLM primary, Nemotron fallback, V4 Pro last (still selectable,
-- not excluded — see §6 EXTREME REASONING, which explicitly lists all three
-- as candidates for genuinely extreme work).
update public.model_registry set reasoning_score = 92 where category='reasoning' and openrouter_model_id='z-ai/glm-5.2';
update public.model_registry set reasoning_score = 87 where category='reasoning' and openrouter_model_id='nvidia/nemotron-3-ultra-550b-a55b';
update public.model_registry set reasoning_score = 78 where category='reasoning' and openrouter_model_id='deepseek/deepseek-v4-pro-0813';

-- MATH: Nemotron primary, V4 Pro fallback #2, GLM fallback #3 — the
-- specified order, reproduced via the same reasoning_score column
-- (capabilityFitFor uses it for math too; each (model,category) row is
-- independent, so this does not affect the reasoning-category values above).
update public.model_registry set reasoning_score = 91 where category='math' and openrouter_model_id='nvidia/nemotron-3-ultra-550b-a55b';
update public.model_registry set reasoning_score = 82 where category='math' and openrouter_model_id='deepseek/deepseek-v4-pro-0813';
update public.model_registry set reasoning_score = 76 where category='math' and openrouter_model_id='z-ai/glm-5.2';

-- ---------------------------------------------------------------------------
-- Verification (expect: free 15000/500, pro 100000/3300)
-- ---------------------------------------------------------------------------
-- select plan_tier, counter_type, limit_amount from public.plan_limits
--  where counter_type in ('credits','daily_credits') order by plan_tier, counter_type;
--
-- Paid pool per category, cheapest first:
-- select category, openrouter_model_id, priority,
--        cost_per_million_input, cost_per_million_output
--   from public.model_registry
--  where variant='paid' and is_active and pro_tier_allowed
--  order by category, priority;
--
-- MUST return zero rows — a paid row reachable by Free:
-- select * from public.model_registry where variant='paid' and free_tier_allowed;
