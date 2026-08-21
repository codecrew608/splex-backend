-- ============================================================================
-- SPLEX — Migration 0012: fix missing pro-tier credit limit + image generation
-- ============================================================================
-- PART A — "SPLEX Credits Remaining" pinned at 100% for pro users (and for
-- anyone whenever a tier/counter row goes missing), reported live.
--
-- Root cause: migration 0011 set pro's monthly credit total with a plain
-- UPDATE ("update plan_limits set limit_amount = 1000000 where
-- plan_tier='pro' and counter_type='credits'"), not an upsert. 'pro' was a
-- dormant, never-wired tier before 0011 (see DEPLOYMENT.md — "previously a
-- dormant, never-wired ₹599 concept"), so there is no evidence a
-- ('pro','credits') row ever existed for that UPDATE to touch. A plain
-- UPDATE against a non-existent row is a silent no-op, not an error.
--
-- Two callers then read that row and both degrade the same way when it's
-- missing:
--   - apps/web/hooks/useCredits.ts + settings/page.tsx: PostgREST .single()
--     on zero rows -> limitRow is null -> total falls back to 0.
--   - apps/web/components/sidebar/Sidebar.tsx: `remainingPct = total > 0 ?
--     100 - pct : 100` — total=0 hits the fallback branch, so the sidebar
--     always renders "100%" regardless of real usage.
--   - apps/backend/src/credits/costBand.ts (resolveCreditGateEstimate) hits
--     the same missing row and silently falls back to a flat 50-credit gate
--     estimate instead of the real percentage-of-plan-total figure.
--
-- Fixed here with a proper upsert so every (tier, counter_type) combination
-- the app actually reads is guaranteed to exist, regardless of whatever
-- partial state the row was already in.
insert into public.plan_limits (plan_tier, counter_type, limit_amount) values
  ('free', 'credits', 50000),
  ('pro',  'credits', 1000000),
  ('free', 'daily_requests', 25),
  ('pro',  'daily_requests', null)
on conflict (plan_tier, counter_type) do update set limit_amount = excluded.limit_amount;

-- Explicit commit boundary. Landed live 2026-08-20: running this whole file
-- as one pasted script in the Supabase SQL Editor executes it as a single
-- implicit transaction (no autocommit between statements), and Postgres
-- refuses to let any statement reference a brand-new enum value (added via
-- ALTER TYPE ... ADD VALUE, in Part B below) until the transaction that
-- added it has committed — using it earlier in the same still-open
-- transaction fails with 55P04 "unsafe use of new enum value: ... New enum
-- values must be committed before they can be used." That error aborted
-- the entire transaction, which per Postgres's normal atomicity rolled
-- back everything already run in it — including the plan_limits upsert
-- directly above, even though that statement itself never touched a new
-- enum value. This COMMIT (and the matching one after Part B's ALTER TYPE
-- block) is what makes each piece land independently instead of all
-- living or dying together.
commit;

-- ============================================================================
-- PART B — Media generation: image + audio, daily quotas, unified table
-- ============================================================================
-- One shared table for every generated-media kind (image now; audio in this
-- same migration; video/PPT reuse this same table + quota mechanism in a
-- later migration, not rebuilt from scratch) — deliberately NOT one table
-- per kind. The V1 spec wants unified usage-transparency ("Images 3/5,
-- Audio 4/5, ...") and a single centrally-configurable entitlement surface
-- rather than scattered checks; a `kind`-tagged table is what makes that a
-- single query instead of four near-identical ones. `status` exists now
-- (not added later) so video's queued/processing/completed/failed/cancelled
-- state machine slots into the same table without a schema change when
-- that phase lands — image/audio are synchronous and always insert
-- directly as 'completed'.
--
-- Daily caps are enforced as a HARD cap independent of (in addition to) the
-- normal shared SPLEX credit pool — same "extra guardrail on top of the
-- pool" pattern already used for workflow_steps/workflow_cost in migration
-- 0011. This matters most for image/audio: OpenRouter currently has no
-- zero-cost model for either, so unlike every other Cortex category's
-- genuinely-$0 :free row, SPLEX pays real money per generation — the daily
-- cap is what keeps that bounded. See apps/backend/src/credits/mediaQuota.ts.
--
-- Full V1 quota schedule declared now (not scattered across later
-- migrations) even though video/PPT aren't implemented yet this phase —
-- plan_limits is meant to be the single source of truth an entitlement
-- service reads, and an unused limit row for a not-yet-built capability is
-- harmless. Free gets image only for V1 (audio/video/PPT are Pro-only —
-- see FREE PLAN media limits in the spec: 0/day for all three).
alter type counter_type add value if not exists 'image_generations';
alter type counter_type add value if not exists 'audio_generations';
alter type counter_type add value if not exists 'video_generations';
alter type counter_type add value if not exists 'ppt_generations';

-- Required — see the commit comment above Part B: everything below this
-- line references one of the four values just added, so they must be
-- committed first or every statement below fails with 55P04.
commit;

insert into public.plan_limits (plan_tier, counter_type, limit_amount) values
  ('free', 'image_generations', 2),
  ('pro',  'image_generations', 5),
  ('free', 'audio_generations', 0),
  ('pro',  'audio_generations', 5),
  ('free', 'video_generations', 0),
  ('pro',  'video_generations', 2),
  ('free', 'ppt_generations', 0),
  ('pro',  'ppt_generations', 2)
on conflict (plan_tier, counter_type) do update set limit_amount = excluded.limit_amount;

-- One row per generation attempt that actually started (not a bare
-- pre-flight rejection) — status='completed' for image/audio's synchronous
-- path inserted directly on success; nothing is inserted at all if
-- generation fails outright, mirroring the app's existing "only
-- charge/count on a clean result" rule for credits. Counting today's
-- non-'failed' rows per user+kind IS the quota check, so no separate
-- incrementing counter is needed. Deliberately a table of its own rather
-- than reusing `files`/its upload-quota trigger — generated media must
-- never count against, or be blocked by, the user's unrelated
-- file-upload/storage caps.
-- IF NOT EXISTS on the table/index (not present in the original draft) —
-- defense in depth given the 55P04 failure above: this file has now been
-- run at least once already and partially failed, so statements that
-- would previously only ever run once now need to tolerate a retry
-- landing on a DB that's already partway through applying this migration.
create table if not exists public.generated_media (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  message_id uuid references public.messages(id) on delete set null,
  kind text not null,                              -- 'image' | 'audio' | 'video' | 'ppt'
  status text not null default 'completed',        -- 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled'
  storage_path text,                                -- null while queued/processing
  prompt text not null,
  provider_job_id text,                             -- set for async kinds (video); null for sync kinds
  cost_usd numeric,
  credits_charged int,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists idx_generated_media_user_kind_created on public.generated_media(user_id, kind, created_at);

alter table public.generated_media enable row level security;
-- Zero policies — same default-deny pattern as model_registry/
-- cortex_decisions: anon/authenticated get nothing, service_role (the
-- backend) bypasses RLS entirely. Nothing in this table is meant to be
-- read directly by the client; delivery happens via a signed URL embedded
-- in the already-authorized message content at generation time.

-- category='image'/'audio' rows. Both are real money on OpenRouter today —
-- no genuinely-$0 :free model exists for either — so unlike every other
-- Cortex category, 'free' variant rows here are NOT $0-cost-to-SPLEX (see
-- comment above); the daily cap is the cost control. Free gets 0 audio
-- quota in V1 (Pro-only capability), so audio has no 'free' variant row at
-- all — it would be structurally unreachable. 'paid' favors quality over
-- 'free' since paid users are both lower-volume (capped anyway) and
-- paying customers. cost_per_million_input/output are 0 and unused for
-- both categories — this pricing is per-call, not per-token, so the actual
-- charge comes from each call's real reported USD cost (image: /images
-- response `usage.cost`; audio: the `X-Generation-Id` response header
-- resolved via GET /generation), not a token-rate estimate. See
-- apps/backend/src/images/generate.ts, apps/backend/src/audio/generate.ts,
-- and apps/backend/src/credits/mediaCost.ts.
--
-- Individually NOT EXISTS-guarded rather than a plain multi-row INSERT —
-- model_registry has no unique constraint on (category, openrouter_model_id,
-- variant) to hang an ON CONFLICT off of, and per the 55P04 failure above
-- this file may now be re-run against a DB that already has some of these
-- rows; a bare INSERT would duplicate them (Cortex would then see two
-- candidates that are really the same model, not a real fallback).
insert into public.model_registry (category, openrouter_model_id, variant, capability_score, context_length, cost_per_million_input, cost_per_million_output, is_active, priority)
select 'image', 'black-forest-labs/flux.2-klein-4b', 'free', 70, 8192, 0, 0, true, 10
where not exists (
  select 1 from public.model_registry where category = 'image' and openrouter_model_id = 'black-forest-labs/flux.2-klein-4b' and variant = 'free'
);

insert into public.model_registry (category, openrouter_model_id, variant, capability_score, context_length, cost_per_million_input, cost_per_million_output, is_active, priority)
select 'image', 'google/gemini-2.5-flash-image', 'paid', 88, 8192, 0, 0, true, 10
where not exists (
  select 1 from public.model_registry where category = 'image' and openrouter_model_id = 'google/gemini-2.5-flash-image' and variant = 'paid'
);

insert into public.model_registry (category, openrouter_model_id, variant, capability_score, context_length, cost_per_million_input, cost_per_million_output, is_active, priority)
select 'audio', 'openai/gpt-4o-mini-tts-2025-12-15', 'paid', 85, 8192, 0, 0, true, 10
where not exists (
  select 1 from public.model_registry where category = 'audio' and openrouter_model_id = 'openai/gpt-4o-mini-tts-2025-12-15' and variant = 'paid'
);

commit;
