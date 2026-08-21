-- ============================================================================
-- SPLEX — Migration 0014: model routing metadata + health telemetry
-- ============================================================================
-- Two related additions, both feeding the new cost-aware router
-- (apps/backend/src/cortex/routing.ts), which replaces the previous
-- "ORDER BY priority, capability_score" model choice with a real
-- quality x cost x latency x reliability score.
--
-- No enum changes anywhere in this file — counter_type already carries
-- every value the entitlement service reads (added in 0012), so the 55P04
-- class of failure that broke 0012's first apply cannot recur here.
--
-- ---------------------------------------------------------------------------
-- PART A — richer per-model metadata
-- ---------------------------------------------------------------------------
-- The registry previously carried a single `capability_score`, which
-- conflates "how good is this model overall" with "how good is it at THIS
-- task" — the router needs those separated to weight differently per task
-- (coding weights coding_score heavily; a simple question weights cost).
-- All added with defaults so existing rows stay valid and every current
-- query keeps working unchanged.
--
-- Scores are 0-100. Defaults deliberately backfill from the existing
-- capability_score rather than a flat constant, so pre-existing rows keep
-- their relative ordering under the new router instead of all collapsing
-- to an identical score on day one.
alter table public.model_registry add column if not exists provider text;
alter table public.model_registry add column if not exists modality text not null default 'text';
alter table public.model_registry add column if not exists quality_score int;
alter table public.model_registry add column if not exists coding_score int;
alter table public.model_registry add column if not exists reasoning_score int;
-- Higher = faster. Unknown until real telemetry accumulates, so it starts
-- neutral rather than pretending to know.
alter table public.model_registry add column if not exists latency_score int not null default 50;
-- Higher = more reliable. Starts optimistic-but-not-perfect; real health
-- data (Part B) overrides this in the router once observations exist.
alter table public.model_registry add column if not exists reliability_score int not null default 70;
-- Explicit per-tier allowances. `variant` already enforces free/paid
-- isolation, but the spec calls for an explicit entitlement flag the
-- router can honor independently — e.g. temporarily barring free users
-- from a specific expensive-but-paid-variant model without deleting the row.
alter table public.model_registry add column if not exists free_tier_allowed boolean not null default true;
alter table public.model_registry add column if not exists pro_tier_allowed boolean not null default true;

update public.model_registry set quality_score   = capability_score where quality_score   is null;
update public.model_registry set coding_score    = capability_score where coding_score    is null;
update public.model_registry set reasoning_score = capability_score where reasoning_score is null;

-- Provider is derivable from the openrouter model id's vendor prefix
-- ("google/veo-3.1-lite" -> "google"). Backfilled rather than left null so
-- provider-level fallback (prefer a DIFFERENT provider on retry) works for
-- pre-existing rows immediately, not only for rows added from here on.
update public.model_registry
set provider = split_part(openrouter_model_id, '/', 1)
where provider is null and openrouter_model_id like '%/%';

-- Media categories are non-text modalities; everything else stays 'text'.
update public.model_registry set modality = category
where category in ('image', 'audio', 'video') and modality = 'text';

-- ---------------------------------------------------------------------------
-- PART B — live model health telemetry
-- ---------------------------------------------------------------------------
-- Separate table rather than more model_registry columns: the registry is
-- low-write configuration, this is high-write observation, and mixing them
-- would mean every generation writes to the same rows the router reads for
-- config. 1:1 with model_registry via PK-as-FK.
--
-- Counters are windowed, not lifetime: `recent_error_rate` is only
-- meaningful over a recent window (a model that failed 200 times last week
-- but works fine now must not stay penalized forever). record_model_health()
-- below resets the window when it ages out, so the numbers here always
-- describe roughly the last hour.
create table if not exists public.model_health (
  model_id uuid primary key references public.model_registry(id) on delete cascade,
  success_count bigint not null default 0,
  failure_count bigint not null default 0,
  timeout_count bigint not null default 0,
  -- Sum, not average — lets the average be recomputed exactly on each
  -- observation without storing a running mean that drifts.
  total_latency_ms bigint not null default 0,
  total_cost_usd numeric not null default 0,
  window_started_at timestamptz not null default now(),
  last_failure_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.model_health enable row level security;
-- Zero policies — same default-deny pattern as model_registry itself.
-- This table is keyed by internal model ids and must never be readable by
-- anon/authenticated; service_role bypasses RLS.

-- Atomic upsert-and-increment. Written as a function (not app-side
-- read-modify-write) because concurrent generations against the same model
-- would otherwise lose updates — two requests reading count=5 and both
-- writing 6. SECURITY DEFINER + service_role-only, matching the lockdown
-- posture established for check_credits/consume_credits in migration 0010.
create or replace function public.record_model_health(
  p_model_id    uuid,
  p_outcome     text,             -- 'success' | 'failure' | 'timeout'
  p_latency_ms  int default null,
  p_cost_usd    numeric default 0
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_age interval;
begin
  insert into public.model_health (model_id) values (p_model_id)
  on conflict (model_id) do nothing;

  select now() - window_started_at into v_window_age
  from public.model_health where model_id = p_model_id;

  -- Roll the window: old observations stop influencing routing entirely
  -- rather than decaying slowly, which keeps "recent" honest and cheap.
  if v_window_age > interval '1 hour' then
    update public.model_health
    set success_count = 0, failure_count = 0, timeout_count = 0,
        total_latency_ms = 0, total_cost_usd = 0, window_started_at = now()
    where model_id = p_model_id;
  end if;

  update public.model_health
  set success_count    = success_count + (case when p_outcome = 'success' then 1 else 0 end),
      failure_count    = failure_count + (case when p_outcome = 'failure' then 1 else 0 end),
      timeout_count    = timeout_count + (case when p_outcome = 'timeout' then 1 else 0 end),
      total_latency_ms = total_latency_ms + coalesce(p_latency_ms, 0),
      total_cost_usd   = total_cost_usd + coalesce(p_cost_usd, 0),
      last_failure_at  = case when p_outcome in ('failure', 'timeout') then now() else last_failure_at end,
      updated_at       = now()
  where model_id = p_model_id;
end;
$$;

revoke execute on function public.record_model_health(uuid, text, int, numeric) from public, anon, authenticated;
grant execute on function public.record_model_health(uuid, text, int, numeric) to service_role;
