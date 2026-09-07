-- 0056 — Groq fallback capacity admission control.
--
-- CONTEXT
-- Free-tier "Grok fallback" request, resolved: the provided key
-- (gsk_...) authenticates against api.groq.com (Groq, Inc. — the LPU
-- fast-inference hardware company), NOT xAI's Grok (api.x.ai, verified
-- last pass to have no free tier at all). Confirmed live, directly against
-- both APIs: the key is rejected by api.x.ai (400) and accepted by
-- api.groq.com (200, real completion succeeded, no billing error).
-- Groq's developer tier is genuinely free — no credit card, no per-token
-- charge — gated only by request/token rate limits, which per Groq's own
-- rate-limits documentation and a live probe against this exact key are
-- organization-wide (not per-key), currently 1,000 requests/day and 8,000
-- tokens/minute for the openai/gpt-oss-20b/120b family.
--
-- WHY THIS MIGRATION EXISTS
-- That 1,000/day cap is shared across ALL of SPLEX's Groq fallback traffic,
-- org-wide — a stretch where OpenRouter's own free capacity is exhausted
-- would otherwise funnel every Free-tier request into Groq with zero
-- admission control, easily exceeding it within minutes under real load.
-- This mirrors migration 0054's OpenRouter capacity admission design
-- exactly (same two-layer shape: proactive per-model + per-user counters,
-- checked atomically before any real dispatch; reactive correction on a
-- live 429) rather than inventing a second mechanism — see that
-- migration's header comment for the full design rationale, which applies
-- unchanged here.

begin;

alter type counter_type add value if not exists 'groq_free_requests';

commit;

begin;

-- Global, per-model, per-UTC-day counter — same shape and same reasoning
-- as provider_free_model_capacity (migration 0054): this resource belongs
-- to no one user, so it does not belong in usage_counters (whose user_id
-- is NOT NULL).
create table if not exists public.provider_groq_capacity (
  model_id     text not null,
  period_start date not null,
  used         integer not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (model_id, period_start)
);

alter table public.provider_groq_capacity enable row level security;
-- No policies — RLS enabled with zero policies denies every role except
-- service_role, matching provider_free_model_capacity's posture.

-- Joint admission check — identical shape to admit_openrouter_free_request,
-- applied to the Groq fallback path instead. Same two return reasons, same
-- fixed lock order (user row then model row) to avoid deadlocks, same
-- fail-closed-on-malformed-input rule.
create or replace function public.admit_groq_fallback_request(
  p_user_id uuid,
  p_model_id text,
  p_per_user_daily_cap integer,
  p_model_daily_cap integer
) returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user_period   date;
  v_model_period  date;
  v_user_used     integer;
  v_model_used    integer;
begin
  if p_user_id is null or p_model_id is null then
    return 'fair_share_exceeded';
  end if;

  v_user_period  := (now() at time zone public.user_timezone(p_user_id))::date;
  v_model_period := (now() at time zone 'utc')::date;

  insert into public.usage_counters (user_id, counter_type, period_start, used)
  values (p_user_id, 'groq_free_requests', v_user_period, 0)
  on conflict (user_id, counter_type, period_start) do nothing;

  insert into public.provider_groq_capacity (model_id, period_start, used)
  values (p_model_id, v_model_period, 0)
  on conflict (model_id, period_start) do nothing;

  select used into v_user_used
  from public.usage_counters
  where user_id = p_user_id and counter_type = 'groq_free_requests' and period_start = v_user_period
  for update;

  select used into v_model_used
  from public.provider_groq_capacity
  where model_id = p_model_id and period_start = v_model_period
  for update;

  if coalesce(v_user_used, 0) >= p_per_user_daily_cap then
    return 'fair_share_exceeded';
  end if;

  if coalesce(v_model_used, 0) >= p_model_daily_cap then
    return 'provider_capacity_exhausted';
  end if;

  update public.usage_counters
     set used = used + 1
   where user_id = p_user_id and counter_type = 'groq_free_requests' and period_start = v_user_period;

  update public.provider_groq_capacity
     set used = used + 1, updated_at = now()
   where model_id = p_model_id and period_start = v_model_period;

  return 'ok';
end;
$function$;

revoke execute on function public.admit_groq_fallback_request(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.admit_groq_fallback_request(uuid, text, integer, integer) to service_role;

-- Reactive correction — same GREATEST()-based idempotent shape as
-- mark_provider_model_exhausted, applied on seeing a live 429 from Groq
-- itself (catches a burst that exceeds the per-minute token limit, which
-- this migration's daily counters cannot see).
create or replace function public.mark_groq_model_exhausted(p_model_id text) returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_period date := (now() at time zone 'utc')::date;
begin
  insert into public.provider_groq_capacity (model_id, period_start, used)
  values (p_model_id, v_period, 1000000)
  on conflict (model_id, period_start) do update
    set used = greatest(public.provider_groq_capacity.used, 1000000),
        updated_at = now();
end;
$function$;

revoke execute on function public.mark_groq_model_exhausted(text) from public, anon, authenticated;
grant execute on function public.mark_groq_model_exhausted(text) to service_role;

commit;
