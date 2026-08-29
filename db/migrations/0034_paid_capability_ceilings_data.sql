-- 0034 — Paid capability day+month ceilings: DATA.
--
-- Second half of the split described in 0033_paid_capability_ceilings.sql's
-- header — MUST run only after that file has been executed and committed
-- on its own. Running this before 0033 (or in the same script/transaction
-- as it) reproduces the original failure:
--
--   ERROR: 55P04: unsafe use of new value "image_generations_monthly" of
--   enum type counter_type
--
-- Naming convention (matches the pre-existing image_generations/
-- video_generations/ppt_generations/web_searches/deep_research counters
-- from migrations 0011/0012/0013/0015/0016, which this does NOT rename):
-- the bare name is the DAILY ceiling, "_monthly" is its monthly
-- counterpart. audio_minutes/vision_inputs/workflow_runs are new
-- capabilities with no prior daily-only counter to stay consistent with,
-- so they follow the same bare=daily convention from the start rather
-- than introducing a second "_daily"-suffixed naming style. This is a
-- deliberate choice, not an oversight: renaming the five existing daily
-- counters to add a "_daily" suffix would require rewriting live rows
-- (touching production data with no functional benefit) and updating
-- already-tested application code (entitlements/index.ts,
-- credits/mediaQuota.ts) that reads them under their current names.
--
-- Paid (`pro`) ceilings, per spec:
--   image      5/day,  60/month
--   video      2/day,  15/month
--   ppt        2/day,  15/month
--   audio      10 min/day, 100 min/month   (duration-summed, not count)
--   web_search 20/day, 300/month
--   deep_research 3/day, 30/month
--   vision_inputs 20/day, 300/month        (Paid only — see below)
--   workflow_runs 3/day, 30/month           (run COUNT, distinct from the
--                                            existing workflow_steps
--                                            per-run step ceiling and
--                                            workflow_cost per-run credit
--                                            ceiling — migration 0011)
--
-- Free is explicitly zeroed for every one of the above EXCEPT
-- vision_inputs — vision/image-understanding is a CORE Free capability
-- (unchanged by this spec), governed by Free's existing credit pool +
-- free-tier model availability alone; adding a hard count cap for Free
-- here would be a regression, not a new protection, so no free/
-- vision_inputs row exists at all. Free's monthly (15,000) and daily
-- (500) SPLEX credit pools, and Paid's (100,000 / 3,300, ₹199/month), are
-- untouched by this migration — they were already set in migration 0032
-- and remain exactly as-is.
--
-- Idempotent: "on conflict (plan_tier, counter_type) do update" means
-- re-running this file after a partial or full success always converges
-- to the same values rather than erroring on a duplicate key.

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
--  where counter_type::text like '%_monthly'
--     or counter_type::text in ('audio_minutes','vision_inputs','workflow_runs')
--  order by counter_type, plan_tier;
-- -- expect 20 rows (11 pro + 9 free — free has no vision_inputs row).
--
-- -- Unchanged, sanity check only:
-- select plan_tier, counter_type, limit_amount from public.plan_limits
--  where counter_type in ('credits','daily_credits') order by plan_tier, counter_type;
-- -- expect free 15000/500, pro 100000/3300 — exactly as migration 0032 left them.
