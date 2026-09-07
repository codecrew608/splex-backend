-- 0058 — Groq dispatch outcome tracking (reliability, not capacity).
--
-- PROBLEM THIS FIXES
-- Migration 0056/0057 track how much of Groq's configured CAPACITY is
-- being used (provider_groq_capacity, groq_free_requests) — that answers
-- "are we near our own configured ceiling", which is a policy question SPLEX
-- controls. It says nothing about a genuinely different question: is Groq
-- ITSELF becoming less reliable — quietly tightening its free-tier terms,
-- degrading service quality, or having outages — independent of whether
-- SPLEX's own configured caps have been reached.
--
-- This matters specifically because Groq's free developer tier carries no
-- contract or SLA (verified against its own docs — see db/migrations/0056's
-- header). SPLEX cannot prevent that risk with code, but it CAN make sure a
-- real degradation is caught fast — from a log/dashboard, not from users
-- complaining — which is the actual, buildable mitigation for an
-- unguaranteed dependency.
--
-- DESIGN: one row per (UTC day, tier), a running success/failure count plus
-- the most recent failure's detail — enough to compute today's real success
-- rate at a glance and see it trend day over day, without the complexity of
-- model_health's rolling-hour window (that table is for ROUTING decisions
-- made on a live signal; this is for a human noticing a trend). Fire-and-
-- forget from the application side, same posture as every other bookkeeping
-- write in this codebase (recordModelOutcome, markModelCapacityExhausted,
-- markGroqModelExhausted) — telemetry must never fail or slow a real
-- request whose actual answer has already been decided.

create table if not exists public.groq_dispatch_outcomes (
  period_start        date not null,
  tier                 text not null check (tier in ('free', 'paid')),
  success              integer not null default 0,
  failure              integer not null default 0,
  last_failure_at      timestamptz,
  last_failure_status  integer,
  last_failure_body    text,
  updated_at           timestamptz not null default now(),
  primary key (period_start, tier)
);

alter table public.groq_dispatch_outcomes enable row level security;
-- No policies — RLS enabled with zero policies denies every role except
-- service_role, matching provider_groq_capacity's own posture: system
-- bookkeeping, never a user-facing read.

create or replace function public.record_groq_dispatch_outcome(
  p_tier text,
  p_success boolean,
  p_status integer default null,
  p_body text default null
) returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_period date := (now() at time zone 'utc')::date;
begin
  if p_tier not in ('free', 'paid') then
    return; -- malformed input: drop silently rather than corrupt a row with an unexpected tier
  end if;

  insert into public.groq_dispatch_outcomes
    (period_start, tier, success, failure, last_failure_at, last_failure_status, last_failure_body)
  values (
    v_period, p_tier,
    case when p_success then 1 else 0 end,
    case when p_success then 0 else 1 end,
    case when p_success then null else now() end,
    case when p_success then null else p_status end,
    case when p_success then null else left(p_body, 500) end
  )
  on conflict (period_start, tier) do update set
    success = public.groq_dispatch_outcomes.success + excluded.success,
    failure = public.groq_dispatch_outcomes.failure + excluded.failure,
    -- Only overwritten on a NEW failure (excluded.last_failure_at is null
    -- on a success row) — a success must never erase the most recent
    -- failure's detail, which is exactly what a plain `set x = excluded.x`
    -- would do the next time this function is called with p_success=true.
    last_failure_at = coalesce(excluded.last_failure_at, public.groq_dispatch_outcomes.last_failure_at),
    last_failure_status = coalesce(excluded.last_failure_status, public.groq_dispatch_outcomes.last_failure_status),
    last_failure_body = coalesce(excluded.last_failure_body, public.groq_dispatch_outcomes.last_failure_body),
    updated_at = now();
end;
$function$;

revoke execute on function public.record_groq_dispatch_outcome(text, boolean, integer, text) from public, anon, authenticated;
grant execute on function public.record_groq_dispatch_outcome(text, boolean, integer, text) to service_role;
