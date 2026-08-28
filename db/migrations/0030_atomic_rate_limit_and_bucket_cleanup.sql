-- Make the per-user rate limiter atomic, and give its table a bounded size.
--
-- THE RACE
--
-- check_and_increment_rate_limit() opened with:
--
--   select window_start, count into ... from rate_limit_buckets
--   where user_id = ... and route_name = ... for update;
--   if not found or <window expired> then
--     insert ... on conflict do update set window_start = now(), count = 1;
--     return true;
--
-- `FOR UPDATE` locks the ROW IT FOUND. When no row exists there is nothing
-- to lock, so two concurrent first-requests both take the not-found branch,
-- both run the upsert, and both return true — leaving count = 1 after two
-- admitted requests. The same applies at every window rollover, which for a
-- 60s window is a predictable moment an attacker can aim at.
--
-- The over-admission is small (a handful of extra requests per window), but
-- the limiter guards routes that cost real provider money, and "small and
-- exploitable on a schedule" is not the property a rate limiter should have.
--
-- THE FIX
--
-- One statement. INSERT ... ON CONFLICT DO UPDATE is atomic under Postgres's
-- own row lock, so concurrent callers serialize and each sees a distinct
-- post-increment count. The window reset is folded into the same statement
-- rather than being a separate branch that can interleave.
--
-- Behaviour preserved exactly: same signature, same return contract (true =
-- allowed), same per-route buckets, same window semantics. Callers and the
-- shared RATE_LIMITS table are unchanged.
create or replace function public.check_and_increment_rate_limit(
  p_user_id        uuid,
  p_route_name     text,
  p_max            integer,
  p_window_seconds integer
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_cutoff timestamptz;
begin
  v_cutoff := now() - make_interval(secs => p_window_seconds);

  insert into public.rate_limit_buckets (user_id, route_name, window_start, count)
  values (p_user_id, p_route_name, now(), 1)
  on conflict (user_id, route_name) do update
    set count = case
                  when public.rate_limit_buckets.window_start <= v_cutoff then 1
                  else public.rate_limit_buckets.count + 1
                end,
        window_start = case
                  when public.rate_limit_buckets.window_start <= v_cutoff then now()
                  else public.rate_limit_buckets.window_start
                end
  returning count into v_count;

  -- Deliberately still increments when over the limit: a caller who keeps
  -- hammering must not be able to hold their own count down, and the count
  -- resets naturally at the next window rollover.
  return v_count <= p_max;
end;
$$;

revoke execute on function public.check_and_increment_rate_limit(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.check_and_increment_rate_limit(uuid, text, integer, integer) to service_role;

-- Bounded growth: one row per (user, route) forever, including for users who
-- never return. Callable prune rather than a cron job — this codebase has no
-- scheduler, and the table is small enough that inventing one would be
-- over-engineering. A stale bucket is harmless (the window has long expired),
-- so this is housekeeping, not correctness.
create or replace function public.prune_stale_rate_limit_buckets(p_older_than interval default interval '7 days')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  delete from public.rate_limit_buckets where window_start < now() - p_older_than;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.prune_stale_rate_limit_buckets(interval) from public, anon, authenticated;
grant execute on function public.prune_stale_rate_limit_buckets(interval) to service_role;
