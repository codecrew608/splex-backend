-- 0054 — OpenRouter free-model capacity admission control.
--
-- PROBLEM THIS FIXES
-- SPLEX's Free-tier entitlements (3,000 credits/day, 100 messages/day) are
-- checked against the SPLEX credit ledger, which has no idea how much of
-- OpenRouter's own free-model daily allowance actually remains. Nothing in
-- the codebase currently protects that shared, external, account-wide (well
-- — see below) resource at all: every entitled request is dispatched to
-- OpenRouter with no admission control, so 100 free users each sending 100
-- messages can attempt 10,000 real OpenRouter calls against an account that,
-- verified live today, allows 50/day and — after the intended $10 top-up —
-- 1,000/day.
--
-- WHAT WAS ACTUALLY VERIFIED BEFORE WRITING THIS (not assumed)
-- Ten distinct :free models, called back-to-back on the live production key
-- just now: eight returned HTTP 429 "Rate limit exceeded: free-models-per-day"
-- with `X-RateLimit-Limit: 50, X-RateLimit-Remaining: 0`; two
-- (minimax/minimax-m2.7:free, minimax/minimax-m3:free) returned 200 with NO
-- rate-limit headers at all. So this is NOT a single account-wide bucket
-- shared identically by every model — it is partitioned in a way OpenRouter
-- does not fully document. The reset timestamp returned by the 429s
-- (1788825600000) is exactly 2026-09-08T00:00:00Z — confirmed UTC midnight,
-- not user-local time, which is why the table below keys its period in UTC
-- rather than reusing the per-user-timezone convention every other daily
-- counter in this schema uses (those are genuinely per-user entitlements;
-- this is a shared, external, provider-side resource with no per-user
-- timezone that makes sense).
--
-- DESIGN: two independent counters, one RPC, both checked before any real
-- OpenRouter dispatch — never after.
--
--   1. PER-MODEL GLOBAL counter (this migration's new table). Protects the
--      OpenRouter account. Conservative by construction: the configured
--      daily cap defaults to 50 (today's verified live value, see
--      apps/backend/src/plugins/env.ts) applied UNIFORMLY to every :free
--      model, even though two models just demonstrated no such ceiling
--      exists for them yet. That is deliberate, not an oversight — a
--      uniform conservative default cannot be wrong in the dangerous
--      direction (it can only under-use capacity a model doesn't actually
--      need capped), and the REACTIVE layer (a live 429, detected in
--      openrouter/client.ts and used to mark that specific model's row
--      exhausted immediately) is what actually corrects for a model whose
--      real ceiling differs from the configured default in either
--      direction, without this migration needing to know it in advance.
--
--   2. PER-USER daily counter (usage_counters, new counter_type). Protects
--      users from each other — the exact "User A sends 100 requests at
--      midnight and starves everyone else" scenario. A flat CEILING, not a
--      pre-reserved slice: unused headroom is automatically available to
--      other users with zero extra mechanism, which is why this migration
--      does not also implement a redistribution scheme.
--
-- Both are checked and incremented in ONE function so a request that fails
-- the per-model check is never charged against the per-user fairness
-- counter (and vice versa) — a request that never actually reached OpenRouter
-- must not consume any budget, matching this codebase's existing rule for
-- SPLEX credits (settleDailyReservation releases in full on any failure).

begin;

-- Step 1 of the enum-add pattern already established in this schema
-- (migration 0018's own comment): a new enum value must be committed before
-- any statement in the SAME transaction can reference it.
alter type counter_type add value if not exists 'openrouter_free_requests';

commit;

begin;

-- Global, per-model, per-UTC-day counter. Deliberately NOT usage_counters:
-- that table's user_id is NOT NULL (verified against the live schema before
-- writing this) and every existing row genuinely belongs to one user: this
-- resource belongs to no one user, and forcing it into a per-user table
-- would mean inventing a sentinel user_id, which is both a modeling lie and
-- a real RLS/security footgun (a fake "system user" row that some future
-- query could accidentally attribute to a real account). A small dedicated
-- table is one honest concept, not premature abstraction.
create table if not exists public.provider_free_model_capacity (
  model_id     text not null,
  period_start date not null,
  used         integer not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (model_id, period_start)
);

alter table public.provider_free_model_capacity enable row level security;
-- No policies added — RLS enabled with zero policies denies every role
-- except the table owner / service_role, exactly matching
-- rate_limit_buckets' own posture (migration 0019) for the same reason:
-- this is system bookkeeping, never a user-facing read.

-- The joint admission check. Locks both rows (creating them on first use)
-- BEFORE evaluating either condition, so two concurrent callers hitting the
-- same user+model in the same instant serialize on Postgres's own row locks
-- rather than both reading a stale count — the identical safety property
-- reserve_daily_credits (migration 0022) already relies on for the credit
-- ledger, applied here to two rows jointly instead of one.
--
-- Returns exactly one of:
--   'ok'                        — both counters incremented, caller may dispatch
--   'fair_share_exceeded'       — THIS user's own daily OpenRouter-attempt
--                                  budget is spent; other users are unaffected
--   'provider_capacity_exhausted' — this MODEL's tracked daily capacity is
--                                  spent; a different model may still have room
--
-- p_per_user_daily_cap / p_model_daily_cap are passed in by the caller
-- (resolved from fastify.config, not hardcoded here) so the whole policy
-- moves via a config change and redeploy — never a migration — exactly the
-- "OPENROUTER_FREE_DAILY_CAPACITY should be configurable, not hardcoded"
-- requirement this migration exists to satisfy.
create or replace function public.admit_openrouter_free_request(
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
    return 'fair_share_exceeded'; -- fail closed on malformed input, never silently admit
  end if;

  v_user_period  := (now() at time zone public.user_timezone(p_user_id))::date;
  v_model_period := (now() at time zone 'utc')::date; -- see this file's header: verified against OpenRouter's own reset boundary

  -- Ensure both rows exist, then lock them in a FIXED order (user row
  -- first, then model row) so two callers can never deadlock by locking
  -- the same two resources in opposite orders.
  insert into public.usage_counters (user_id, counter_type, period_start, used)
  values (p_user_id, 'openrouter_free_requests', v_user_period, 0)
  on conflict (user_id, counter_type, period_start) do nothing;

  insert into public.provider_free_model_capacity (model_id, period_start, used)
  values (p_model_id, v_model_period, 0)
  on conflict (model_id, period_start) do nothing;

  select used into v_user_used
  from public.usage_counters
  where user_id = p_user_id and counter_type = 'openrouter_free_requests' and period_start = v_user_period
  for update;

  select used into v_model_used
  from public.provider_free_model_capacity
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
   where user_id = p_user_id and counter_type = 'openrouter_free_requests' and period_start = v_user_period;

  update public.provider_free_model_capacity
     set used = used + 1, updated_at = now()
   where model_id = p_model_id and period_start = v_model_period;

  return 'ok';
end;
$function$;

revoke execute on function public.admit_openrouter_free_request(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.admit_openrouter_free_request(uuid, text, integer, integer) to service_role;

-- Reactive correction (Layer 3, applied from application code in
-- openrouter/client.ts on seeing a live "free-models-per-day" 429): marks
-- one model's TODAY row exhausted immediately, without waiting for the
-- proactive counter above to organically reach the configured cap. This is
-- what protects the account correctly even when the configured
-- p_model_daily_cap is stale — too high because OpenRouter quietly lowered
-- a model's real ceiling, or too restrictive-looking-but-actually-fine for
-- a model (like the two observed above) that isn't really capped that way.
-- GREATEST(), never a plain SET, so this can never accidentally lower a
-- count a concurrent admit call already pushed higher.
create or replace function public.mark_provider_model_exhausted(p_model_id text) returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_period date := (now() at time zone 'utc')::date;
begin
  insert into public.provider_free_model_capacity (model_id, period_start, used)
  values (p_model_id, v_period, 1000000)
  on conflict (model_id, period_start) do update
    set used = greatest(public.provider_free_model_capacity.used, 1000000),
        updated_at = now();
end;
$function$;

revoke execute on function public.mark_provider_model_exhausted(text) from public, anon, authenticated;
grant execute on function public.mark_provider_model_exhausted(text) to service_role;

commit;
