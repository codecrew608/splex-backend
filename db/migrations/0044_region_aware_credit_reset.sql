-- FIX (user-reported, 2026-09-04): "make sure that the credits for the
-- users change according to their region time within 24hrs of full credits
-- usage" — every daily/monthly reset boundary in this schema was hardcoded
-- to Asia/Kolkata regardless of where the user actually is, so a user in a
-- different timezone got their daily quota/credits reset at a time of day
-- that has nothing to do with their own midnight.
--
-- Design: add a per-user IANA timezone column (defaulting to the previous
-- fixed behavior, so no existing user's reset time silently moves), a
-- STABLE helper that resolves it safely (falls back to Asia/Kolkata for
-- any user row with no timezone recorded yet, or a corrupted/unrecognized
-- value — validated against pg_timezone_names so a bad value can never
-- make a credit-gate function error out), and thread that helper through
-- every function that previously hardcoded 'Asia/Kolkata'. The write side
-- (capturing the browser's real timezone) lives in the backend
-- (handlers/account.ts) and frontend (OnboardingModal.tsx, Sidebar.tsx) —
-- this migration only changes what the database does with whatever value
-- ends up there.

alter table public.users
  add column if not exists timezone text not null default 'Asia/Kolkata';

comment on column public.users.timezone is
  'IANA timezone name (e.g. Asia/Kolkata, America/New_York). Drives daily/monthly credit and usage reset boundaries for this user. Captured client-side (Intl.DateTimeFormat().resolvedOptions().timeZone) via POST /account/profile or PATCH /account/timezone; defaults to Asia/Kolkata (this app''s prior fixed behavior) until then.';

-- Resolves a user's timezone for use in `at time zone`. The
-- pg_timezone_names join is a safety net, not decoration: it means a
-- corrupted/unrecognized value in users.timezone degrades to the old fixed
-- behavior instead of making every credit-gate function that calls this
-- throw an error (which would fail a paying user's request outright).
-- p_user_id may be null (e.g. a not-yet-resolved caller) — the join simply
-- finds nothing and the coalesce still returns the safe default.
create or replace function public.user_timezone(p_user_id uuid)
returns text
language sql
stable
set search_path = public
as $$
  select coalesce(
    (
      select u.timezone
      from public.users u
      join pg_timezone_names tz on tz.name = u.timezone
      where u.id = p_user_id
    ),
    'Asia/Kolkata'
  );
$$;

-- New functions default to PUBLIC-executable at creation (see migration
-- 0043's own comment on this exact gotcha) — this one has no business
-- being called directly by anon/authenticated (it would let any signed-in
-- caller probe an arbitrary user id for their timezone), and every real
-- caller is a SECURITY DEFINER function below that doesn't need its own
-- EXECUTE grant on this to call it.
revoke execute on function public.user_timezone(uuid) from public;

-- get_period_start gains an optional user id. Every real caller now passes
-- one; the default keeps the old Asia/Kolkata behavior for correctness in
-- case anything ever calls this with just a counter type again.
create or replace function public.get_period_start(p_counter_type counter_type, p_user_id uuid default null)
returns date
language sql
stable
set search_path = public
as $$
  select case
    when p_counter_type = 'daily_requests' then (now() at time zone public.user_timezone(p_user_id))::date
    else date_trunc('month', now() at time zone public.user_timezone(p_user_id))::date
  end;
$$;

-- Was already RPC-exposed before this migration (not one of 0043's three
-- fixes) — closing that now while touching this function anyway, same
-- reasoning as user_timezone above: nothing legitimate calls this over
-- PostgREST, only from within other SECURITY DEFINER functions.
revoke execute on function public.get_period_start(counter_type, uuid) from public, anon, authenticated;

create or replace function public.check_credits(p_user_id uuid, p_credit_cost integer)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tier              plan_tier;
  v_credit_limit      integer;
  v_credits_used      integer;
  v_credit_period      date;
  v_daily_limit       integer;
  v_daily_used        integer;
  v_daily_period      date;
begin
  select plan_tier into v_tier from public.users where id = p_user_id;

  v_credit_period := public.get_period_start('credits', p_user_id);
  select limit_amount into v_credit_limit
  from public.plan_limits where plan_tier = v_tier and counter_type = 'credits';
  select coalesce(used, 0) into v_credits_used
  from public.usage_counters
  where user_id = p_user_id and counter_type = 'credits' and period_start = v_credit_period;

  if coalesce(v_credits_used, 0) + p_credit_cost > coalesce(v_credit_limit, 0) then
    return false;
  end if;

  if v_tier = 'free' then
    v_daily_period := public.get_period_start('daily_requests', p_user_id);
    select limit_amount into v_daily_limit
    from public.plan_limits where plan_tier = v_tier and counter_type = 'daily_requests';
    select coalesce(used, 0) into v_daily_used
    from public.usage_counters
    where user_id = p_user_id and counter_type = 'daily_requests' and period_start = v_daily_period;

    if coalesce(v_daily_used, 0) + 1 > coalesce(v_daily_limit, 0) then
      return false;
    end if;
  end if;

  return true;
end;
$$;

create or replace function public.consume_credits(
  p_user_id uuid,
  p_credit_cost integer,
  p_intent text,
  p_complexity complexity_level,
  p_openrouter_model_id text,
  p_real_cost_estimate numeric default 0,
  p_real_input_tokens integer default null,
  p_real_output_tokens integer default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tier          plan_tier;
  v_credit_period date;
  v_daily_period  date;
begin
  select plan_tier into v_tier from public.users where id = p_user_id;
  v_credit_period := public.get_period_start('credits', p_user_id);

  insert into public.usage_counters (user_id, counter_type, period_start, used)
  values (p_user_id, 'credits', v_credit_period, p_credit_cost)
  on conflict (user_id, counter_type, period_start)
  do update set used = public.usage_counters.used + excluded.used;

  if v_tier = 'free' then
    v_daily_period := public.get_period_start('daily_requests', p_user_id);
    insert into public.usage_counters (user_id, counter_type, period_start, used)
    values (p_user_id, 'daily_requests', v_daily_period, 1)
    on conflict (user_id, counter_type, period_start)
    do update set used = public.usage_counters.used + 1;
  end if;

  insert into public.credit_usage_logs
    (user_id, intent, complexity, openrouter_model_id, credits_consumed, real_cost_estimate, real_input_tokens, real_output_tokens)
  values
    (p_user_id, p_intent, p_complexity, p_openrouter_model_id, p_credit_cost, p_real_cost_estimate, p_real_input_tokens, p_real_output_tokens);
end;
$$;

create or replace function public.check_daily_credits(p_user_id uuid, p_credit_cost integer)
returns boolean
language plpgsql
security definer
set search_path to 'public'
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

  v_period := (now() at time zone public.user_timezone(p_user_id))::date;

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
set search_path to 'public'
as $$
declare
  v_period date;
begin
  v_period := (now() at time zone public.user_timezone(p_user_id))::date;

  insert into public.usage_counters (user_id, counter_type, period_start, used)
  values (p_user_id, 'daily_credits', v_period, p_credit_cost)
  on conflict (user_id, counter_type, period_start)
  do update set used = public.usage_counters.used + excluded.used;
end;
$$;

create or replace function public.reserve_daily_credits(p_user_id uuid, p_reserve_amount integer)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tier   plan_tier;
  v_limit  integer;
  v_period date;
  v_result integer;
begin
  select plan_tier into v_tier from public.users where id = p_user_id;
  if v_tier is null then
    return false;
  end if;

  select limit_amount into v_limit
  from public.plan_limits where plan_tier = v_tier and counter_type = 'daily_credits';
  if v_limit is null then
    return false;
  end if;

  if p_reserve_amount > v_limit then
    return false;
  end if;

  v_period := (now() at time zone public.user_timezone(p_user_id))::date;

  insert into public.usage_counters (user_id, counter_type, period_start, used)
  values (p_user_id, 'daily_credits', v_period, p_reserve_amount)
  on conflict (user_id, counter_type, period_start) do update
    set used = usage_counters.used + excluded.used
    where usage_counters.used + excluded.used <= v_limit
  returning used into v_result;

  return v_result is not null;
end;
$$;

create or replace function public.diagnose_credit_rejection(p_user_id uuid, p_credit_cost integer, p_monthly_only boolean default false)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tier                plan_tier;
  v_credit_limit        integer;
  v_credits_used        integer;
  v_credit_period       date;
  v_daily_credit_limit  integer;
  v_daily_credit_used   integer;
  v_daily_credit_period date;
  v_daily_req_limit     integer;
  v_daily_req_used      integer;
  v_daily_req_period    date;
begin
  select plan_tier into v_tier from public.users where id = p_user_id;
  if v_tier is null then
    return 'unknown_user';
  end if;

  v_credit_period := public.get_period_start('credits', p_user_id);
  select limit_amount into v_credit_limit
  from public.plan_limits where plan_tier = v_tier and counter_type = 'credits';
  select coalesce(used, 0) into v_credits_used
  from public.usage_counters
  where user_id = p_user_id and counter_type = 'credits' and period_start = v_credit_period;
  if coalesce(v_credits_used, 0) + p_credit_cost > coalesce(v_credit_limit, 0) then
    return 'monthly_credits_exhausted';
  end if;

  if not p_monthly_only then
    select limit_amount into v_daily_credit_limit
    from public.plan_limits where plan_tier = v_tier and counter_type = 'daily_credits';
    if v_daily_credit_limit is not null then
      v_daily_credit_period := (now() at time zone public.user_timezone(p_user_id))::date;
      select used into v_daily_credit_used
      from public.usage_counters
      where user_id = p_user_id and counter_type = 'daily_credits' and period_start = v_daily_credit_period;
      if (coalesce(v_daily_credit_used, 0) + p_credit_cost) > v_daily_credit_limit then
        return 'daily_credits_exhausted';
      end if;
    end if;
  end if;

  if v_tier = 'free' then
    v_daily_req_period := public.get_period_start('daily_requests', p_user_id);
    select limit_amount into v_daily_req_limit
    from public.plan_limits where plan_tier = v_tier and counter_type = 'daily_requests';
    select coalesce(used, 0) into v_daily_req_used
    from public.usage_counters
    where user_id = p_user_id and counter_type = 'daily_requests' and period_start = v_daily_req_period;
    if coalesce(v_daily_req_used, 0) + 1 > coalesce(v_daily_req_limit, 0) then
      return 'daily_request_limit_exhausted';
    end if;
  end if;

  return 'ok';
end;
$$;
