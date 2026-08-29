-- 0033 — Paid capability day+month ceilings: SCHEMA ONLY.
--
-- Split from what was originally one file, after a real failed execution
-- attempt against production returned:
--
--   ERROR: 55P04: unsafe use of new value "image_generations_monthly" of
--   enum type counter_type
--
-- Postgres will not let a transaction reference a brand-new enum value
-- (compare it, cast it, insert it as data) in the SAME transaction that
-- added it — the safety rule exists because other backends could already
-- be mid-transaction against the old enum contents when the ADD VALUE
-- runs, and allowing an uncommitted label to be used immediately would
-- make the enum's on-disk representation ambiguous for them. The whole
-- point of ADD VALUE is that it's cheap and lock-light BECAUSE it defers
-- exactly this hazard onto "don't use it before it's committed" rather
-- than rewriting the type.
--
-- This file contains ONLY the enum additions and the one plain-integer
-- column add (which was never actually the problem — duration_seconds is
-- a normal column, not an enum reference — but it's kept here because
-- it's schema, not data, and grouping all DDL together makes the "run
-- 0033, let it commit, then run 0034" instruction unambiguous). See
-- 0034_paid_capability_ceilings_data.sql for the plan_limits rows that
-- actually USE these new labels — that file MUST run only after this one
-- has committed, as its own separate execution (see DEPLOYMENT.md / the
-- report this was delivered with for the exact procedure).
--
-- Verified against a fresh read of production before writing this split:
-- the earlier failed attempt left ZERO trace — none of these eleven
-- labels exist on counter_type, generated_media has no duration_seconds
-- column, and plan_limits is still exactly 33 rows. Postgres rolled the
-- whole failed script back as one transaction; there is nothing partial
-- to clean up. This file is safe to run once, fresh, from that state.
--
-- Idempotent: every statement uses IF NOT EXISTS, so re-running this file
-- after a partial or full success is always safe and a no-op past the
-- first successful run.

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
-- Verification (run after this file, before running 0034)
-- ---------------------------------------------------------------------------
-- select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
--  where t.typname = 'counter_type' order by e.enumsortorder;
-- -- expect all eleven new labels present, in addition to the original 17.
--
-- select column_name from information_schema.columns
--  where table_name = 'generated_media' and column_name = 'duration_seconds';
-- -- expect one row.
