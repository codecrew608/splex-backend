-- 0055 — Atomic daily message-count admission, generalized entitlement
-- limits, and exact-string error codes.
--
-- PROBLEM THIS FIXES
-- daily_requests (the free-tier message-count cap) has never had an atomic
-- reservation. check_credits() only READS it (see its body below, unchanged
-- until this migration); the only place it was ever incremented was inside
-- consume_credits(), which only runs after a generation has already
-- streamed a full response. Concrete race: a Free user at 49/50 messages
-- fires 10 simultaneous requests — every one reads used=49, every one
-- passes the < 50 check, every one proceeds to generate and only THEN
-- increments, landing at 59/50. Verified by direct read of the live
-- function body (pg_get_functiondef), not assumed.
--
-- This mirrors the exact atomic pattern already proven for daily_credits in
-- migration 0022 (reserve_daily_credits: one INSERT ... ON CONFLICT ...
-- WHERE ... RETURNING, atomic under Postgres's own row lock on the unique
-- constraint — no explicit SELECT ... FOR UPDATE needed) — reused here
-- rather than inventing a second mechanism.
--
-- SECOND FIX: check_credits() and diagnose_credit_rejection()'s
-- daily_requests block was gated on the literal condition `v_tier = 'free'`
-- — not on whether a limit is actually configured for that tier. That
-- meant Paid users were structurally exempt from any daily_requests gating
-- regardless of what plan_limits said, which is why plan_limits.pro
-- daily_requests could sit at NULL with no enforcement path at all even if
-- someone had set it. Changed to check "is a limit configured", so a future
-- (or, per this same migration, present) Paid daily-message cap actually
-- takes effect through this read-only pre-check path too — not just through
-- the new atomic reserve below.
--
-- THIRD: plan_limits numbers updated to the values the current spec
-- requires — free daily_requests 100 -> 50, pro daily_requests NULL -> 75.
-- Both are real reductions/additions to live entitlements. Flagged to the
-- user separately; proceeding per their explicit "make engineering
-- decisions where clear" instruction, since these are just numbers in an
-- existing, already-live limits table, not a currency/pricing change.
--
-- FOURTH: consume_credits() gains an optional p_skip_daily_request flag,
-- mirroring the EXACT shape of the existing p_skip_daily-equivalent
-- (application-side `skipDaily`) fix for the credits pool (see
-- consumeCredits.ts's doc comment — this exact double-count bug shipped
-- once already, for credits, and produced a verified 2x overcharge in
-- production). Only chat.ts's plain-chat path is switched to the new
-- reserve-before-generate flow and passes true; every other consumeCredits()
-- call site (workflow steps, media generation, research) is UNCHANGED and
-- keeps incrementing daily_requests exactly as it does today — this
-- migration does not alter their behavior, since altering it was not
-- requested and not evidenced as broken.

-- ---------------------------------------------------------------------------
-- 1. Atomic reservation, generalized to any tier with a configured limit.
-- ---------------------------------------------------------------------------
create or replace function public.reserve_daily_request(p_user_id uuid)
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
    return false; -- unknown user: fail closed
  end if;

  select limit_amount into v_limit
  from public.plan_limits where plan_tier = v_tier and counter_type = 'daily_requests';

  if v_limit is null then
    -- No configured daily message cap for this tier: uncapped, nothing to
    -- reserve or track. Distinct from the daily_credits pattern (which
    -- fails closed on NULL) because daily_requests has always had
    -- genuinely-unlimited tiers (dormant 'starter' today) by design, not by
    -- omission.
    return true;
  end if;

  v_period := public.get_period_start('daily_requests', p_user_id);

  insert into public.usage_counters (user_id, counter_type, period_start, used)
  values (p_user_id, 'daily_requests', v_period, 1)
  on conflict (user_id, counter_type, period_start) do update
    set used = usage_counters.used + 1
    where usage_counters.used + 1 <= v_limit
  returning used into v_result;

  return v_result is not null;
end;
$function$;

-- Releases a reservation made by reserve_daily_request() when the request
-- did NOT complete successfully — mirrors this codebase's existing rule
-- (see consume_credits below, and the pre-existing daily_requests semantics)
-- that a failed/aborted generation must not count against the daily message
-- cap. No settle-with-delta step is needed here (unlike credits): a message
-- is always exactly 1, never a variable real cost, so reserve is either kept
-- (success) or fully released (failure) — never trued up.
create or replace function public.release_daily_request(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_period date;
begin
  v_period := public.get_period_start('daily_requests', p_user_id);
  update public.usage_counters
  set used = greatest(0, used - 1)
  where user_id = p_user_id and counter_type = 'daily_requests' and period_start = v_period;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 2. check_credits(): daily_requests gate becomes limit-driven, not
--    tier-name-driven. Everything else in this function is unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.check_credits(p_user_id uuid, p_credit_cost integer)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
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

  select limit_amount into v_daily_limit
  from public.plan_limits where plan_tier = v_tier and counter_type = 'daily_requests';

  if v_daily_limit is not null then
    v_daily_period := public.get_period_start('daily_requests', p_user_id);
    select coalesce(used, 0) into v_daily_used
    from public.usage_counters
    where user_id = p_user_id and counter_type = 'daily_requests' and period_start = v_daily_period;

    if coalesce(v_daily_used, 0) + 1 > v_daily_limit then
      return false;
    end if;
  end if;

  return true;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. diagnose_credit_rejection(): same limit-driven fix, mirroring
--    check_credits() exactly (per its own doc comment's stated invariant).
-- ---------------------------------------------------------------------------
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

  select limit_amount into v_daily_req_limit
  from public.plan_limits where plan_tier = v_tier and counter_type = 'daily_requests';
  if v_daily_req_limit is not null then
    v_daily_req_period := public.get_period_start('daily_requests', p_user_id);
    select coalesce(used, 0) into v_daily_req_used
    from public.usage_counters
    where user_id = p_user_id and counter_type = 'daily_requests' and period_start = v_daily_req_period;
    if coalesce(v_daily_req_used, 0) + 1 > v_daily_req_limit then
      return 'daily_request_limit_exhausted';
    end if;
  end if;

  return 'ok';
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. consume_credits(): daily_requests increment becomes conditional on a
--    new p_skip_daily_request flag (default false — every existing call
--    site's behavior is UNCHANGED). Also generalized off the v_tier='free'
--    hardcode to match check_credits() above, so it only ever increments
--    when a limit is actually configured for the caller's tier.
-- ---------------------------------------------------------------------------
create or replace function public.consume_credits(
  p_user_id uuid,
  p_credit_cost integer,
  p_intent text,
  p_complexity complexity_level,
  p_openrouter_model_id text,
  p_real_cost_estimate numeric default 0,
  p_real_input_tokens integer default null::integer,
  p_real_output_tokens integer default null::integer,
  p_skip_daily_request boolean default false
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tier          plan_tier;
  v_credit_period date;
  v_daily_period  date;
  v_daily_limit   integer;
begin
  select plan_tier into v_tier from public.users where id = p_user_id;
  v_credit_period := public.get_period_start('credits', p_user_id);

  insert into public.usage_counters (user_id, counter_type, period_start, used)
  values (p_user_id, 'credits', v_credit_period, p_credit_cost)
  on conflict (user_id, counter_type, period_start)
  do update set used = public.usage_counters.used + excluded.used;

  if not p_skip_daily_request then
    select limit_amount into v_daily_limit
    from public.plan_limits where plan_tier = v_tier and counter_type = 'daily_requests';

    if v_daily_limit is not null then
      v_daily_period := public.get_period_start('daily_requests', p_user_id);
      insert into public.usage_counters (user_id, counter_type, period_start, used)
      values (p_user_id, 'daily_requests', v_daily_period, 1)
      on conflict (user_id, counter_type, period_start)
      do update set used = public.usage_counters.used + 1;
    end if;
  end if;

  insert into public.credit_usage_logs
    (user_id, intent, complexity, openrouter_model_id, credits_consumed, real_cost_estimate, real_input_tokens, real_output_tokens)
  values
    (p_user_id, p_intent, p_complexity, p_openrouter_model_id, p_credit_cost, p_real_cost_estimate, p_real_input_tokens, p_real_output_tokens);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. plan_limits: free daily_requests 100 -> 50, pro daily_requests
--    NULL -> 75. Flagged to the user in the same turn this migration was
--    written — proceeding per their "make engineering decisions yourself
--    wherever requirements are clear" instruction, since these are plain
--    numbers in an already-live table, not a pricing/currency change.
-- ---------------------------------------------------------------------------
update public.plan_limits set limit_amount = 50
  where plan_tier = 'free' and counter_type = 'daily_requests';

insert into public.plan_limits (plan_tier, counter_type, limit_amount)
values ('pro', 'daily_requests', 75)
on conflict (plan_tier, counter_type) do update set limit_amount = excluded.limit_amount;
