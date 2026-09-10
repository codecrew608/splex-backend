-- 0064 — OpenRouter CREDENTIAL health (observability, not routing).
--
-- PROBLEM THIS FIXES
-- Migration 0054 tracks per-MODEL free capacity and per-USER fair share;
-- cortex/modelHealth.ts tracks per-MODEL reliability. None of them answer
-- a genuinely different, account-level question: is the OpenRouter
-- CREDENTIAL itself (the "API 1" key) currently rejected/disabled, and
-- when did a request last succeed with it? Before this, a 401 from a bad
-- or revoked key was recorded as an ordinary per-model failure — poisoning
-- that model's routing health for an account-level problem it says nothing
-- about (the same bug class the 402/balance branch already avoids) — with
-- no signal anywhere that the key is the thing that broke.
--
-- DESIGN: one row per credential alias (today only 'api1'; 'api2' is the
-- Pro-reserved slot and is never written here while Pro is off). Point-in
-- -time, not a daily-trend table like groq_dispatch_outcomes — the useful
-- question here is "is it broken right now, and when did it last work",
-- not "what was the success rate on the 3rd". Written fire-and-forget from
-- cortex/modelHealth.ts, the single existing choke point for OpenRouter
-- dispatch outcomes; NEVER read by any routing decision — this is a
-- dashboard/log signal only, exactly like groq_dispatch_outcomes.

create table if not exists public.openrouter_credential_health (
  credential_alias      text primary key,
  last_success_at       timestamptz,
  last_failure_at       timestamptz,
  last_auth_failure_at  timestamptz,
  last_failure_status   integer,
  last_failure_kind     text,
  updated_at            timestamptz not null default now()
);

alter table public.openrouter_credential_health enable row level security;
-- No policies — RLS enabled with zero policies denies every role except
-- service_role, matching provider_free_model_capacity / groq_dispatch_outcomes:
-- system bookkeeping, never a user-facing read.

create or replace function public.record_openrouter_credential_outcome(
  p_alias text,
  p_success boolean,
  p_status integer default null,
  p_kind text default null
) returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if p_alias is null or length(p_alias) = 0 then
    return; -- malformed input: drop silently rather than write a keyless row
  end if;

  insert into public.openrouter_credential_health
    (credential_alias, last_success_at, last_failure_at, last_auth_failure_at, last_failure_status, last_failure_kind)
  values (
    p_alias,
    case when p_success then now() else null end,
    case when p_success then null else now() end,
    case when (not p_success) and p_kind = 'auth' then now() else null end,
    case when p_success then null else p_status end,
    case when p_success then null else left(p_kind, 40) end
  )
  on conflict (credential_alias) do update set
    -- Each timestamp/detail is only advanced by the matching kind of
    -- outcome — a success must never erase the last failure detail, and a
    -- non-auth failure must never touch last_auth_failure_at.
    last_success_at      = coalesce(excluded.last_success_at, public.openrouter_credential_health.last_success_at),
    last_failure_at      = coalesce(excluded.last_failure_at, public.openrouter_credential_health.last_failure_at),
    last_auth_failure_at = coalesce(excluded.last_auth_failure_at, public.openrouter_credential_health.last_auth_failure_at),
    last_failure_status  = coalesce(excluded.last_failure_status, public.openrouter_credential_health.last_failure_status),
    last_failure_kind    = coalesce(excluded.last_failure_kind, public.openrouter_credential_health.last_failure_kind),
    updated_at           = now();
end;
$function$;

revoke execute on function public.record_openrouter_credential_outcome(text, boolean, integer, text) from public, anon, authenticated;
grant execute on function public.record_openrouter_credential_outcome(text, boolean, integer, text) to service_role;
