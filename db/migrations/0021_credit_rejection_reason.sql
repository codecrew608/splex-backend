-- ============================================================================
-- SPLEX — Migration 0021: distinguish credit-exhaustion from daily-request-
-- limit rejections
-- ============================================================================
-- Root cause of "Free users incorrectly see 'out of credits'" (the second,
-- separate half of that report — the first half was the daily/monthly
-- credit-gate estimate bug fixed in apps/backend/src/credits/costBand.ts):
-- check_credits() already correctly enforces two INDEPENDENT things for a
-- free-tier user — the monthly/daily CREDIT pools, and a separate
-- daily_requests MESSAGE-COUNT cap (plan_limits.daily_requests, 25/day) —
-- but only ever returns a single boolean. Every call site then shows the
-- same "You've used your available SPLEX credits" message regardless of
-- which one actually failed. Confirmed live: a fresh test account with
-- 10/3000 monthly and 10/150 daily credits remaining (nowhere near
-- exhausted) got the credits-exhausted message purely from having its
-- daily_requests counter at 25 — a real, misleading result, not a
-- hypothetical one.
--
-- This migration adds ONE new, purely diagnostic, read-only function. It
-- does not change check_credits(), check_daily_credits(), consume_credits(),
-- consume_daily_credits(), or any plan_limits value — the actual gate
-- behavior is byte-for-byte unchanged. diagnose_credit_rejection() mirrors
-- those functions' own checks exactly (same tables, same period
-- boundaries, same order) so the reason it reports is always consistent
-- with whatever check_credits()/check_daily_credits() already decided —
-- callers run it ONLY after checkCredits() has already returned false,
-- purely to choose the right user-facing message. It never gates a
-- request on its own.
--
-- Precedence when multiple conditions are true (documented here and
-- mirrored in apps/backend/src/credits/checkCredits.ts's
-- resolveCreditRejectionMessage): credits_exhausted is checked first and
-- returned immediately if true, before the daily_requests check ever
-- runs — this exactly mirrors check_credits()'s own internal ordering
-- (its monthly-credit block returns early, before its embedded
-- daily_requests block). A user who is simultaneously out of credits AND
-- past their daily request count sees the credits message, not the
-- daily-limit message.
-- ============================================================================

-- Postgres identifies a function by name + parameter TYPES, so the earlier
-- 2-arg version of this function (applied moments before this one, in the
-- same development session, never used by any deployed code) is a
-- genuinely different signature from the 3-arg version below — CREATE OR
-- REPLACE would not replace it, it would leave both overloads present.
-- Drop it explicitly so exactly one version of this function exists.
drop function if exists public.diagnose_credit_rejection(uuid, integer);

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

  -- 1. Monthly credit pool — same check as check_credits()'s first block.
  -- Runs regardless of p_monthly_only: check_credits() always runs this
  -- block, whether or not the caller also separately calls
  -- check_daily_credits().
  v_credit_period := public.get_period_start('credits');
  select limit_amount into v_credit_limit
  from public.plan_limits where plan_tier = v_tier and counter_type = 'credits';
  select coalesce(used, 0) into v_credits_used
  from public.usage_counters
  where user_id = p_user_id and counter_type = 'credits' and period_start = v_credit_period;
  if coalesce(v_credits_used, 0) + p_credit_cost > coalesce(v_credit_limit, 0) then
    return 'credits_exhausted';
  end if;

  -- 2. Daily credit pool — same check as check_daily_credits(). Skipped
  -- when p_monthly_only is true, matching checkCredits.ts's own
  -- monthlyOnly option: a monthlyOnly caller (Agent Workflow's/Deep
  -- Research's ceiling checks) never invokes check_daily_credits() at
  -- all, so reporting a rejection based on the daily pool here would
  -- describe a check the real gate never actually ran.
  if not p_monthly_only then
    select limit_amount into v_daily_credit_limit
    from public.plan_limits where plan_tier = v_tier and counter_type = 'daily_credits';
    if v_daily_credit_limit is not null then
      v_daily_credit_period := (now() at time zone 'Asia/Kolkata')::date;
      select used into v_daily_credit_used
      from public.usage_counters
      where user_id = p_user_id and counter_type = 'daily_credits' and period_start = v_daily_credit_period;
      if (coalesce(v_daily_credit_used, 0) + p_credit_cost) > v_daily_credit_limit then
        return 'credits_exhausted';
      end if;
    end if;
  end if;

  -- 3. Free-tier daily message-count cap — the embedded check inside
  -- check_credits() itself (not a separate RPC), so it runs regardless of
  -- p_monthly_only, exactly like check_credits()'s own free-tier branch.
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

-- Same service-role-only lockdown as check_credits/consume_credits
-- (migration 0010) — this reads per-user usage data, never callable
-- directly by anon/authenticated.
revoke execute on function public.diagnose_credit_rejection(uuid, integer, boolean) from public, anon, authenticated;
grant execute on function public.diagnose_credit_rejection(uuid, integer, boolean) to service_role;
