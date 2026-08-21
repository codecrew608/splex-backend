-- ============================================================================
-- SPLEX — Migration 0018: Starter plan economics + model routing upgrade
-- ============================================================================
-- Per explicit product decision: V1 has exactly two user-facing plans, Free
-- and Starter (₹299/month). The internal plan_tier enum value 'pro' is kept
-- unchanged (avoids an unnecessary, risky rename of a live column every
-- other table/RPC already references) — "Starter" is a display-layer label
-- applied in application code, not a database rename. The dormant 'starter'
-- enum value (a retired, never-wired-to-real-users ₹299 concept from before
-- 'pro' took over that role — see DEPLOYMENT.md's "What changed today") is
-- left untouched: no live user has that plan_tier, nothing reads it.
--
-- SPLEX Credits are renormalized: 1 credit = $0.00005 (20,000 credits = $1),
-- replacing the previous $0.00004 (25,000 credits = $1) rate. New pool
-- sizes (free 3,000/mo + 150/day; pro/"Starter" 15,000/mo + 750/day) are a
-- deliberate, large reduction from the previous free=50,000/mo and
-- pro=1,000,000/mo — see the economics note near the bottom of this file
-- for the real-cost-ceiling math this produces.
--
-- Also fixes two real, live-verified data problems found while grounding
-- this migration against the current OpenRouter catalog (per the spec's
-- own explicit "inspect real pricing before changing anything" instruction):
--   1. model_registry's web_search/google-gemini-3.6-flash row stored
--      cost_per_million_input/output roughly 1000x below that model's real
--      current OpenRouter price ($0.0008/$0.0038 stored vs $0.75/$3.75
--      real). This value feeds computeRealCost() for ordinary chat/workflow
--      billing and costPenaltyFor() for routing — a 1000x-stale number
--      would either bill far under real cost or badly distort cost-aware
--      routing, depending on which category ends up using it. Several other
--      active paid rows were also stale by smaller (0.3x-1.7x) margins;
--      corrected here from a live catalog pull, not memory.
--   2. audio's registered model (openai/gpt-4o-mini-tts-2025-12-15) no
--      longer exists on OpenRouter at all — confirmed via a real, direct
--      POST /audio/speech call returning "Model ... does not exist" — so
--      audio generation has been unconditionally broken. Replaced with
--      mistralai/voxtral-mini-tts-2603, confirmed live on the current
--      /api/v1/models?output_modalities=speech listing and specifically
--      named (alongside the now-dead OpenAI model) in OpenRouter's own TTS
--      guide as a supported /audio/speech model.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. New counter_type: daily_credits — commit before use (55P04 pattern,
--    same as every enum addition this project has made since migration
--    0012's original mistake).
-- ---------------------------------------------------------------------------
alter type counter_type add value if not exists 'daily_credits';
commit;

-- ---------------------------------------------------------------------------
-- 2. Renormalize plan_limits: monthly credits, new daily_credits rows.
--    Explicit values, not silently derived — see spec section 4/19's own
--    "do not silently change these" instruction. daily_requests (the
--    OLDER, request-COUNT limit, unrelated to credit amount) is untouched.
-- ---------------------------------------------------------------------------
update public.plan_limits set limit_amount = 3000  where plan_tier = 'free' and counter_type = 'credits';
update public.plan_limits set limit_amount = 15000 where plan_tier = 'pro'  and counter_type = 'credits';

insert into public.plan_limits (plan_tier, counter_type, limit_amount)
select 'free', 'daily_credits', 150
where not exists (select 1 from public.plan_limits where plan_tier = 'free' and counter_type = 'daily_credits');

insert into public.plan_limits (plan_tier, counter_type, limit_amount)
select 'pro', 'daily_credits', 750
where not exists (select 1 from public.plan_limits where plan_tier = 'pro' and counter_type = 'daily_credits');

-- ---------------------------------------------------------------------------
-- 3. Daily credit RPCs — deliberately NOT modifying check_credits()/
--    consume_credits() (migration 0004/0010): their exact current SQL body
--    isn't in any tracked migration (created before this repo's migration-
--    file convention started) and this environment has no direct psql
--    access to read it back safely, so blind-replacing them risks silently
--    breaking the already-proven monthly-credits/daily_requests logic.
--    These are new, additive, independently-correct functions instead —
--    same atomic INSERT ... ON CONFLICT DO UPDATE pattern already proven
--    in consume_credits(), same service-role-only lockdown, called
--    alongside (not instead of) the existing monthly check/consume from
--    application code (see checkCredits.ts/consumeCredits.ts).
--
--    Day boundary: Asia/Kolkata, matching the boundary every OTHER per-day
--    quota in this app already uses (entitlements/index.ts's
--    startOfTodayIST(), in place since before this migration for image/
--    video/audio/ppt/web_search/deep_research/file_uploads) — not naive
--    UTC, and not a new per-user-timezone system (which the schema has no
--    precedent or storage for, and which the spec explicitly warns is an
--    exploitable surface if trusted per-request from the client). This is
--    the same server-authoritative, already-battle-tested boundary the
--    rest of the app relies on, applied consistently to credits too.
-- ---------------------------------------------------------------------------
create or replace function public.check_daily_credits(p_user_id uuid, p_credit_cost integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tier    plan_tier;
  v_limit   integer;
  v_used    integer;
  v_period  date;
begin
  select plan_tier into v_tier from public.users where id = p_user_id;
  if v_tier is null then
    return false; -- unknown user: fail closed
  end if;

  select limit_amount into v_limit
  from public.plan_limits
  where plan_tier = v_tier and counter_type = 'daily_credits';

  if v_limit is null then
    return false; -- no configured daily cap for this tier: fail closed, never "unlimited"
  end if;

  v_period := (now() at time zone 'Asia/Kolkata')::date;

  select used into v_used
  from public.usage_counters
  where user_id = p_user_id and counter_type = 'daily_credits' and period_start = v_period;

  return (coalesce(v_used, 0) + p_credit_cost) <= v_limit;
end;
$$;

create or replace function public.consume_daily_credits(p_user_id uuid, p_credit_cost integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period date;
begin
  v_period := (now() at time zone 'Asia/Kolkata')::date;

  insert into public.usage_counters (user_id, counter_type, period_start, used)
  values (p_user_id, 'daily_credits', v_period, p_credit_cost)
  on conflict (user_id, counter_type, period_start)
  do update set used = public.usage_counters.used + excluded.used;
end;
$$;

revoke execute on function public.check_daily_credits(uuid, integer) from public, anon, authenticated;
revoke execute on function public.consume_daily_credits(uuid, integer) from public, anon, authenticated;
grant execute on function public.check_daily_credits(uuid, integer) to service_role;
grant execute on function public.consume_daily_credits(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Fix stale cost_per_million_input/output on existing ACTIVE paid rows —
--    real pricing pulled live from GET /api/v1/models on 2026-08-21, not
--    from memory. web_search's gemini-3.6-flash row is handled in step 6
--    below (deactivated + replaced, not just repriced, since it's also
--    being swapped for a newer/cheaper model per the spec).
-- ---------------------------------------------------------------------------
update public.model_registry set cost_per_million_input = 0.30, cost_per_million_output = 1.00
  where category = 'coding' and openrouter_model_id = 'qwen/qwen3-coder' and variant = 'paid';
update public.model_registry set cost_per_million_input = 0.80, cost_per_million_output = 1.00
  where category in ('documents','vision') and openrouter_model_id = 'qwen/qwen2.5-vl-72b-instruct' and variant = 'paid';
update public.model_registry set cost_per_million_input = 0.10, cost_per_million_output = 0.32
  where category in ('general','reasoning') and openrouter_model_id = 'meta-llama/llama-3.3-70b-instruct' and variant = 'paid';
update public.model_registry set cost_per_million_input = 0.70, cost_per_million_output = 2.50
  where category = 'math' and openrouter_model_id = 'deepseek/deepseek-r1' and variant = 'paid';
update public.model_registry set cost_per_million_input = 0.03, cost_per_million_output = 0.13
  where category = 'ppt' and openrouter_model_id = 'openai/gpt-oss-20b' and variant = 'paid';
update public.model_registry set cost_per_million_input = 0.36, cost_per_million_output = 0.40
  where category = 'writing' and openrouter_model_id = 'qwen/qwen-2.5-72b-instruct' and variant = 'paid';

-- ---------------------------------------------------------------------------
-- 5. Fix audio: openai/gpt-4o-mini-tts-2025-12-15 no longer exists on
--    OpenRouter (confirmed live, real 400 "Model ... does not exist").
--    Deactivate rather than delete (rollback-friendly, matches this
--    project's existing convention), insert the verified replacement.
-- ---------------------------------------------------------------------------
update public.model_registry set is_active = false
  where category = 'audio' and openrouter_model_id = 'openai/gpt-4o-mini-tts-2025-12-15';

insert into public.model_registry (category, openrouter_model_id, variant, capability_score, context_length, cost_per_million_input, cost_per_million_output, is_active, priority, free_tier_allowed, pro_tier_allowed)
select 'audio', 'mistralai/voxtral-mini-tts-2603', 'paid', 80, 0, 16, 0, true, 10, false, true
where not exists (
  select 1 from public.model_registry where category = 'audio' and openrouter_model_id = 'mistralai/voxtral-mini-tts-2603' and variant = 'paid'
);

-- ---------------------------------------------------------------------------
-- 6. Model routing upgrade — every model ID below verified live against
--    OpenRouter's current /api/v1/models catalog before insertion (all
--    four exist; exact pricing/context/tool-support pulled from the same
--    response, not invented). Existing correctly-priced rows are DEMOTED
--    (priority raised) rather than removed or deactivated — preserves
--    provider diversification (google/deepseek/qwen/meta-llama/alibaba all
--    still present as fallback candidates) and keeps the existing
--    cost-aware scorer (routing.ts) actually choosing between real options
--    rather than a single hardcoded winner, per the spec's own explicit
--    "do not use ORDER BY priority alone" instruction. All free-tier
--    (variant='free') rows are untouched — the spec names Starter-tier
--    models only.
-- ---------------------------------------------------------------------------

-- Demote existing paid rows that are being joined by new primaries (not
-- replaced) — lower priority number wins the seed ordering, so raising
-- these numbers keeps them in the candidate pool as real fallbacks without
-- them out-competing the new primaries at equal quality.
update public.model_registry set priority = 30 where variant = 'paid' and is_active
  and (category, openrouter_model_id) in (
    ('coding', 'qwen/qwen3-coder'),
    ('general', 'meta-llama/llama-3.3-70b-instruct'),
    ('reasoning', 'meta-llama/llama-3.3-70b-instruct'),
    ('math', 'deepseek/deepseek-r1'),
    ('documents', 'qwen/qwen2.5-vl-72b-instruct'),
    ('vision', 'qwen/qwen2.5-vl-72b-instruct'),
    ('writing', 'qwen/qwen-2.5-72b-instruct'),
    ('ppt', 'openai/gpt-oss-20b')
  );

-- google/gemini-3.7-flash — Starter primary for chat/general, reasoning,
-- math (normal), documents, vision, writing, web_search, PPT planning.
-- Real: $0.375/$1.875 per M tokens, 1,048,576 context, tools supported
-- (needed for web_search), vision+audio+video input modalities. Notably
-- CHEAPER than the 3.6-flash row it replaces for web_search ($0.75/$3.75)
-- as well as higher-quality per OpenRouter's own naming generation.
insert into public.model_registry (category, openrouter_model_id, variant, capability_score, context_length, cost_per_million_input, cost_per_million_output, is_active, priority, free_tier_allowed, pro_tier_allowed)
select v.category, 'google/gemini-3.7-flash', 'paid', v.score, 1048576, 0.375, 1.875, true, 10, false, true
from (values
  ('general', 86), ('reasoning', 86), ('math', 84), ('documents', 84),
  ('vision', 84), ('writing', 84), ('web_search', 88), ('ppt', 80)
) as v(category, score)
where not exists (
  select 1 from public.model_registry where category = v.category and openrouter_model_id = 'google/gemini-3.7-flash' and variant = 'paid'
);

-- deepseek/deepseek-v4-flash-0731 — coding primary, chat/math/reasoning/
-- writing/web_search fallback, large-document summarization. Real:
-- $0.14/$0.28 per M tokens (cheapest of the four new models), 1,310,720
-- context, text-only (no vision), tools supported.
insert into public.model_registry (category, openrouter_model_id, variant, capability_score, context_length, cost_per_million_input, cost_per_million_output, is_active, priority, free_tier_allowed, pro_tier_allowed)
select v.category, 'deepseek/deepseek-v4-flash-0731', 'paid', v.score, 1310720, 0.14, 0.28, true, v.priority, false, true
from (values
  ('coding', 88, 10), ('general', 78, 20), ('reasoning', 82, 20),
  ('math', 82, 20), ('writing', 78, 20), ('web_search', 78, 20), ('documents', 80, 20)
) as v(category, score, priority)
where not exists (
  select 1 from public.model_registry where category = v.category and openrouter_model_id = 'deepseek/deepseek-v4-flash-0731' and variant = 'paid'
);

-- deepseek/deepseek-v4-pro-0813 — high-complexity coding/math/reasoning
-- escalation only. Real: $1.188/$3.564 per M tokens (the most expensive
-- model added — by design, only picked when complexity/quality weighting
-- in the existing cost-aware scorer actually favors it, never via a
-- separate hardcoded "if complex" branch). Inserted at LOW priority
-- (40) — it seeds into the candidate pool but never wins on priority
-- alone; scoreModels()'s quality/capability weighting for the "complex"
-- profile is what should surface it, consistent with "do not create a
-- parallel routing system."
insert into public.model_registry (category, openrouter_model_id, variant, capability_score, context_length, cost_per_million_input, cost_per_million_output, is_active, priority, free_tier_allowed, pro_tier_allowed)
select v.category, 'deepseek/deepseek-v4-pro-0813', 'paid', v.score, 1048576, 1.188, 3.564, true, 40, false, true
from (values ('coding', 94), ('math', 92), ('reasoning', 92)) as v(category, score)
where not exists (
  select 1 from public.model_registry where category = v.category and openrouter_model_id = 'deepseek/deepseek-v4-pro-0813' and variant = 'paid'
);

-- qwen/qwen3.8-27b — vision fallback. Real: $0.45/$3.20 per M tokens,
-- 1,000,000 context, text+image+video input, tools supported.
insert into public.model_registry (category, openrouter_model_id, variant, capability_score, context_length, cost_per_million_input, cost_per_million_output, is_active, priority, free_tier_allowed, pro_tier_allowed)
select 'vision', 'qwen/qwen3.8-27b', 'paid', 82, 1000000, 0.45, 3.20, true, 20, false, true
where not exists (
  select 1 from public.model_registry where category = 'vision' and openrouter_model_id = 'qwen/qwen3.8-27b' and variant = 'paid'
);

-- Deactivate the old, dramatically-stale-priced web_search paid row —
-- superseded by gemini-3.7-flash above (same provider, newer, cheaper,
-- correctly priced). Deactivated rather than deleted, matching this
-- project's rollback-friendly convention.
update public.model_registry set is_active = false
  where category = 'web_search' and openrouter_model_id = 'google/gemini-3.6-flash' and variant = 'paid';

-- ============================================================================
-- Economics note (spec section 4/19 — "if the numbers are structurally
-- unsafe, STOP and report the exact calculation"):
--
-- 1 credit = $0.00005 (20,000/$1). Free = 3,000 credits/mo => $0.15/mo real
-- OpenRouter-cost CEILING (mathematically — see checkCredits/consumeCredits,
-- a request that would exceed the remaining pool is blocked before
-- execution, and non-text capabilities bill from OpenRouter's own reported
-- real cost via fetchGenerationCost, never an estimate). Starter (internal
-- 'pro') = 15,000 credits/mo => $0.75/mo real ceiling. Against ₹299/month
-- (~$3.50 at a representative INR/USD rate), that is a MAXIMUM-POSSIBLE-
-- USAGE gross margin of roughly (3.50 - 0.75) / 3.50 ≈ 78% — and realistic
-- average usage (not every user maxing their pool every month) will run
-- meaningfully higher than that floor. This ceiling is only real, however,
-- if the credit-to-real-cost conversion is itself accurate — which step 4
-- above exists to restore (the pre-existing 1000x-stale web_search pricing
-- would have silently let real cost run far ahead of what credits implied
-- for that one category). With that fixed, the numbers are NOT structurally
-- unsafe; the previous free=50,000/mo (~$2.00 real ceiling) and pro
-- =1,000,000/mo (~$40 real ceiling, since CREDITS_PER_USD was 25,000 then)
-- were the ones with much more headroom. This migration tightens that
-- headroom substantially and deliberately, per the new agreed numbers.
-- ============================================================================
