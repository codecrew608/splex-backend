-- Persistent credit reservation for asynchronous media jobs (video).
--
-- THE GAP THIS CLOSES
--
-- Synchronous generation reserves credits atomically and settles them in a
-- try/finally inside ONE request (migration 0022's reserve_daily_credits +
-- consume_daily_credits). Async video cannot use that shape: the job is
-- SUBMITTED in one request and only CHARGED in a later polling request,
-- minutes later. So the submit path used a read-only check_credits(), which
-- reserves nothing:
--
--   * two concurrent submits could both pass the read-only check and both
--     later charge (the concurrency cap is itself read-then-act, so it does
--     not serialize them either);
--   * a user could submit a video, spend the rest of their daily pool on
--     chat, and still have the video charge on completion, pushing usage
--     past the cap.
--
-- A per-request try/finally structurally cannot express this. The
-- reservation has to outlive the request, so it is stored ON THE JOB ROW.
--
-- WHY reservation_period EXISTS
--
-- consume_daily_credits() hardcodes `(now() at time zone 'Asia/Kolkata')::date`.
-- A video submitted at 23:58 and completing at 00:02 would reserve against
-- yesterday's counter and settle against today's — leaking the reservation
-- on one day and mis-charging the other. Recording the period the
-- reservation was actually made against, and settling against THAT, is the
-- only correct behaviour across a period boundary.
alter table public.generated_media
  add column if not exists credits_reserved integer not null default 0,
  add column if not exists reservation_period date;

comment on column public.generated_media.credits_reserved is
  'Daily credits currently held for this in-flight job. >0 means an unsettled reservation exists. Zeroed by settle_media_reservation(), which is idempotent.';
comment on column public.generated_media.reservation_period is
  'usage_counters.period_start the reservation was made against. Settled against this, never against "today", so a job spanning midnight IST trues up the correct day.';

-- Partial index: the sweeper and any operational query only ever look for
-- rows with an outstanding reservation, which is a tiny minority of the table.
create index if not exists generated_media_open_reservation_idx
  on public.generated_media (created_at)
  where credits_reserved > 0;

-- Reserve against the daily pool AND stamp the job row, atomically.
--
-- Deliberately mirrors reserve_daily_credits() exactly (same tier lookup,
-- same limit source, same conditional-increment that cannot exceed the cap)
-- rather than reimplementing the rule, so async video is gated by
-- identically the same arithmetic as chat. The only addition is stamping the
-- row so the reservation can be found and settled later.
create or replace function public.reserve_media_credits(
  p_media_id uuid,
  p_reserve_amount integer
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user   uuid;
  v_tier   plan_tier;
  v_limit  integer;
  v_period date;
  v_result integer;
begin
  select user_id into v_user from public.generated_media where id = p_media_id for update;
  if v_user is null then
    return false;
  end if;

  select plan_tier into v_tier from public.users where id = v_user;
  if v_tier is null then
    return false;
  end if;

  select limit_amount into v_limit
  from public.plan_limits where plan_tier = v_tier and counter_type = 'daily_credits';
  -- Fail CLOSED on a missing limit row, matching reserve_daily_credits and
  -- check_daily_credits. A tier with no configured daily cap must never be
  -- treated as unlimited.
  if v_limit is null then
    return false;
  end if;

  if p_reserve_amount > v_limit then
    return false;
  end if;

  v_period := (now() at time zone 'Asia/Kolkata')::date;

  insert into public.usage_counters (user_id, counter_type, period_start, used)
  values (v_user, 'daily_credits', v_period, p_reserve_amount)
  on conflict (user_id, counter_type, period_start) do update
    set used = usage_counters.used + excluded.used
    where usage_counters.used + excluded.used <= v_limit
  returning used into v_result;

  if v_result is null then
    return false;
  end if;

  update public.generated_media
     set credits_reserved = p_reserve_amount,
         reservation_period = v_period
   where id = p_media_id;

  return true;
end;
$$;

-- Settle (or fully release) a job's reservation. IDEMPOTENT.
--
-- Idempotency is not optional here: the status endpoint is polled every ~6s
-- and two polls can race on the same completing job. `for update` serializes
-- them and the credits_reserved = 0 guard makes the second call a no-op, so
-- a job can never be settled twice.
--
-- p_actual_cost 0 fully releases (failure, cancellation, expiry, orphan).
-- Any other value trues the reservation up or down to the real charge.
create or replace function public.settle_media_reservation(
  p_media_id uuid,
  p_actual_cost integer
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reserved integer;
  v_period   date;
  v_user     uuid;
  v_delta    integer;
begin
  select credits_reserved, reservation_period, user_id
    into v_reserved, v_period, v_user
  from public.generated_media
  where id = p_media_id
  for update;

  if not found or coalesce(v_reserved, 0) = 0 then
    return false;  -- nothing outstanding; already settled or never reserved
  end if;

  v_delta := p_actual_cost - v_reserved;

  if v_delta <> 0 and v_period is not null then
    -- greatest(0, ...) guards the release direction: a negative delta must
    -- never drive a counter below zero and hand back credits that were
    -- never consumed. consume_daily_credits() lacks this guard because it
    -- only ever settles a reservation it made in the same request.
    update public.usage_counters
       set used = greatest(0, used + v_delta)
     where user_id = v_user
       and counter_type = 'daily_credits'
       and period_start = v_period;
  end if;

  update public.generated_media set credits_reserved = 0 where id = p_media_id;
  return true;
end;
$$;

-- Orphan sweeper.
--
-- A reservation is released by the polling request. If nobody ever polls
-- again — the user closes the tab, the job silently stalls upstream — the
-- reservation would pin part of that user's daily pool indefinitely. This
-- releases anything still outstanding on a non-terminal job older than the
-- cutoff and marks the job failed, so the pool self-heals without operator
-- intervention.
--
-- Conservative by construction: only touches rows that are BOTH
-- non-terminal AND older than the caller's cutoff, so a legitimately
-- long-running job is never cut short by a short cutoff.
create or replace function public.release_stale_media_reservations(
  p_max_age interval default interval '30 minutes'
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row   record;
  v_count integer := 0;
begin
  for v_row in
    select id from public.generated_media
    where credits_reserved > 0
      and status in ('queued', 'processing')
      and created_at < now() - p_max_age
    for update skip locked
  loop
    perform public.settle_media_reservation(v_row.id, 0);
    update public.generated_media
       set status = 'failed',
           error_message = coalesce(error_message, 'timed out with no completion signal')
     where id = v_row.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- service_role only, matching every other credit function's lockdown
-- (migration 0010's posture). These move real billing state and must never
-- be callable by anon/authenticated.
revoke execute on function public.reserve_media_credits(uuid, integer) from public, anon, authenticated;
revoke execute on function public.settle_media_reservation(uuid, integer) from public, anon, authenticated;
revoke execute on function public.release_stale_media_reservations(interval) from public, anon, authenticated;
grant execute on function public.reserve_media_credits(uuid, integer) to service_role;
grant execute on function public.settle_media_reservation(uuid, integer) to service_role;
grant execute on function public.release_stale_media_reservations(interval) to service_role;
