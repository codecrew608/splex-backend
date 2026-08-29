-- 0033 — Paid capability day+month ceilings, on top of the existing
-- daily/monthly SPLEX credit pools (migration 0032 set those; this
-- migration does not touch credits/daily_credits at all).
--
-- Three things:
--   1. Schema: eleven new counter_type enum values (the monthly
--      counterpart of every premium capability, plus vision_inputs and
--      workflow_runs, which had no quota mechanism at all before this),
--      and one new nullable column (generated_media.duration_seconds,
--      for audio's minutes-based ceiling).
--   2. Paid (`pro`) ceilings, per spec:
--        image      5/day,  60/month
--        video      2/day,  15/month
--        ppt        2/day,  15/month
--        audio      10 min/day, 100 min/month   (duration-summed, not count)
--        web_search 20/day, 300/month
--        deep_research 3/day, 30/month
--        vision_inputs 20/day, 300/month        (Paid only — see below)
--        workflow_runs 3/day, 30/month           (run COUNT, distinct from
--                                                  the existing workflow_steps
--                                                  per-run step ceiling and
--                                                  workflow_cost per-run
--                                                  credit ceiling)
--   3. Free explicitly zeroed for every one of the above except
--      vision_inputs — vision/image-understanding is a CORE Free
--      capability (unchanged by this spec), governed by Free's existing
--      credit pool + free-tier model availability alone; adding a hard
--      count cap for Free here would be a regression, not a new
--      protection, so no free/vision_inputs row exists at all.
--
-- image_generations/video_generations/ppt_generations/web_searches/
-- deep_research already existed as DAILY-only ceilings (migrations
-- 0011/0012/0013/0015/0016). This migration adds their monthly
-- counterpart under a "_monthly" suffix rather than restructuring the
-- existing naming — one consistent, additive convention.

-- ---------------------------------------------------------------------------
-- 1. Schema
-- ---------------------------------------------------------------------------

alter type counter_type add value if not exists 'image_generations_monthly';
alter type counter_type add value if not exists 'video_generations_monthly';
alter type counter_type add value if not exists 'ppt_generations_monthly';
alter type counter_type add value if not exists 'web_searches_monthly';
alter type counter_type add value if not exists 'deep_research_monthly';
alter type counter_type add value if not exists 'audio_minutes';
alter type counter_type add value if not exists 'audio_minutes_monthly';
alter type counter_type add value if not exists 'vision_inputs';
alter type counter_type add value if not exists 'vision_inputs_monthly';
alter type counter_type add value if not exists 'workflow_runs';
alter type counter_type add value if not exists 'workflow_runs_monthly';

-- Estimated from the returned audio file's byte size (no duration field
-- exists in OpenRouter's TTS response) — see audio/generate.ts's own
-- provenance comment. Null for every non-audio kind, and for any audio
-- row generated before this migration (entitlements/index.ts treats null
-- as 0 seconds, never as unknown/infinite).
alter table public.generated_media add column if not exists duration_seconds integer;

-- ---------------------------------------------------------------------------
-- 2. Paid ceilings
-- ---------------------------------------------------------------------------
-- NOTE ON PLpgSQL "insert ... on conflict do nothing": plan_limits' primary
-- key is (plan_tier, counter_type), so this is safe to re-run and safe
-- against a counter_type that already had a stray row from manual testing.

insert into public.plan_limits (plan_tier, counter_type, limit_amount) values
  ('pro', 'image_generations_monthly', 60),
  ('pro', 'video_generations_monthly', 15),
  ('pro', 'ppt_generations_monthly', 15),
  ('pro', 'web_searches_monthly', 300),
  ('pro', 'deep_research_monthly', 30),
  ('pro', 'audio_minutes', 10),
  ('pro', 'audio_minutes_monthly', 100),
  ('pro', 'vision_inputs', 20),
  ('pro', 'vision_inputs_monthly', 300),
  ('pro', 'workflow_runs', 3),
  ('pro', 'workflow_runs_monthly', 30)
on conflict (plan_tier, counter_type) do update set limit_amount = excluded.limit_amount;

-- ---------------------------------------------------------------------------
-- 3. Free stays explicitly blocked from every premium ceiling above
--    (vision_inputs excluded on purpose — see the header comment).
-- ---------------------------------------------------------------------------

insert into public.plan_limits (plan_tier, counter_type, limit_amount) values
  ('free', 'image_generations_monthly', 0),
  ('free', 'video_generations_monthly', 0),
  ('free', 'ppt_generations_monthly', 0),
  ('free', 'web_searches_monthly', 0),
  ('free', 'deep_research_monthly', 0),
  ('free', 'audio_minutes', 0),
  ('free', 'audio_minutes_monthly', 0),
  ('free', 'workflow_runs', 0),
  ('free', 'workflow_runs_monthly', 0)
on conflict (plan_tier, counter_type) do update set limit_amount = excluded.limit_amount;

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------
-- select plan_tier, counter_type, limit_amount from public.plan_limits
--  where counter_type::text like '%_monthly' or counter_type::text in
--    ('audio_minutes','vision_inputs','workflow_runs')
--  order by counter_type, plan_tier;
--
-- select column_name from information_schema.columns
--  where table_name = 'generated_media' and column_name = 'duration_seconds';
