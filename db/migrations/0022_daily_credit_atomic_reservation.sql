-- ============================================================================
-- SPLEX — Migration 0022: atomic daily-credit reservation + 3-way rejection
-- reason (monthly credits / daily credits / daily message count)
-- ============================================================================
-- Root cause of the reported "307 / 150 SPLEX Credits used today" bug,
-- confirmed against real production data (credit_usage_logs for a real
-- Free user): two ordinary SEQUENTIAL "complex" requests, 25 seconds
-- apart, charged 99 and 107 credits respectively — nowhere near
-- simultaneous, so this was not literally two browser tabs racing. The
-- actual defect: the pre-flight gate (apps/backend/src/credits/costBand.ts)
-- checks a small ESTIMATE (~15 credits for a "complex" request post the
-- earlier costBand.ts fix) against the daily pool, but the REAL amount
-- charged afterward (from actual token usage) is not bounded by that
-- estimate at all — real complex-request costs of 99-180 credits were
-- observed. A gate sized to avoid false rejections is, by construction,
-- too small to protect a 150-credit pool from a request whose real cost
-- can be 10x that estimate. Two such requests compound past 150 with zero
-- concurrency involved.
--
-- A SEPARATE, independent problem exists on top of that: even with a
-- perfectly-sized estimate, checking (SELECT) and later consuming
-- (INSERT/UPDATE) as two separate steps, seconds apart while generation
-- runs, is a classic TOCTOU race — two genuinely simultaneous requests
-- could both pass the same check before either has recorded anything.
--
-- Both are fixed together the correct way: RESERVE the estimated cost
-- atomically at gate time (this migration's new function), then TRUE UP
-- to the real cost (or fully release on failure) via the EXISTING
-- consume_daily_credits() — unchanged, reused with a signed delta. The
-- atomicity comes from a single INSERT ... ON CONFLICT DO UPDATE ... WHERE
-- statement: Postgres takes the row lock for that one statement's
-- duration, so two concurrent reservations for the same user/day
-- genuinely serialize at the database level rather than both reading a
-- stale "used" value in application code.
--
-- Also splits diagnose_credit_rejection()'s single 'credits_exhausted'
-- reason into 'monthly_credits_exhausted' and 'daily_credits_exhausted' —
-- these are two of the three genuinely distinct concepts (monthly pool,
-- daily pool, daily message count) that must each get their own message.
--
-- Nothing about check_credits(), check_daily_credits(),
-- consume_credits(), consume_daily_credits(), or any plan_limits value
-- changes. This migration only ADDS reserve_daily_credits() and updates
-- diagnose_credit_rejection()'s return values.
-- ============================================================================

create or replace function public.reserve_daily_credits(p_user_id uuid, p_reserve_amount integer)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
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
    -- Mirrors check_daily_credits()'s own fail-closed semantics exactly
    -- (a tier with no configured daily_credits row, e.g. today's
    -- 'starter', is never treated as "unlimited"). This function replaces
    -- check_daily_credits() at the gate for non-monthlyOnly callers, so it
    -- must fail identically or a request could pass one and fail the
    -- other.
    return false;
  end if;

  if p_reserve_amount > v_limit then
    return false; -- a single reservation that alone exceeds the whole pool can never be granted
  end if;

  v_period := (now() at time zone 'Asia/Kolkata')::date;

  -- Single atomic statement: the fresh-insert branch is always safe
  -- (p_reserve_amount <= v_limit already checked above), and the
  -- conflict/update branch is guarded by the WHERE clause. Postgres
  -- serializes concurrent callers on the row lock this statement takes —
  -- there is no gap between "read used" and "write used" for a second
  -- caller to land in.
  insert into public.usage_counters (user_id, counter_type, period_start, used)
  values (p_user_id, 'daily_credits', v_period, p_reserve_amount)
  on conflict (user_id, counter_type, period_start) do update
    set used = usage_counters.used + excluded.used
    where usage_counters.used + excluded.used <= v_limit
  returning used into v_result;

  return v_result is not null;
end;
$function$;

revoke execute on function public.reserve_daily_credits(uuid, integer) from public, anon, authenticated;
grant execute on function public.reserve_daily_credits(uuid, integer) to service_role;

-- Split 'credits_exhausted' into the two genuinely distinct pools. Order
-- unchanged (monthly checked before daily, matching check_credits()'s own
-- internal ordering) — a user exhausted on both sees the monthly message,
-- documented as the deliberate precedence in checkCredits.ts.
create or replace function public.diagnose_credit_rejection(p_user_id uuid, p_credit_cost integer, p_monthly_only boolean default false)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
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

  -- 1. Monthly credit pool
  v_credit_period := public.get_period_start('credits');
  select limit_amount into v_credit_limit
  from public.plan_limits where plan_tier = v_tier and counter_type = 'credits';
  select coalesce(used, 0) into v_credits_used
  from public.usage_counters
  where user_id = p_user_id and counter_type = 'credits' and period_start = v_credit_period;
  if coalesce(v_credits_used, 0) + p_credit_cost > coalesce(v_credit_limit, 0) then
    return 'monthly_credits_exhausted';
  end if;

  -- 2. Daily credit pool (skipped when p_monthly_only)
  if not p_monthly_only then
    select limit_amount into v_daily_credit_limit
    from public.plan_limits where plan_tier = v_tier and counter_type = 'daily_credits';
    if v_daily_credit_limit is not null then
      v_daily_credit_period := (now() at time zone 'Asia/Kolkata')::date;
      select used into v_daily_credit_used
      from public.usage_counters
      where user_id = p_user_id and counter_type = 'daily_credits' and period_start = v_daily_credit_period;
      if (coalesce(v_daily_credit_used, 0) + p_credit_cost) > v_daily_credit_limit then
        return 'daily_credits_exhausted';
      end if;
    end if;
  end if;

  -- 3. Free-tier daily message-count cap (always runs, matches check_credits' embedded check)
  if v_tier = 'free' then
    v_daily_req_period := public.get_period_start('daily_requests');
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
$function$;
