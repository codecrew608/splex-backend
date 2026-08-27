-- Postgres-backed rate limiting for the Cloudflare Workers Free deployment
-- target (see deploy/backend/src/worker/). The existing in-memory limiters
-- (plugins/rateLimit.ts's @fastify/rate-limit default store,
-- plugins/userRateLimit.ts's Map + setInterval sweep) assume one
-- long-lived Node process with shared memory across requests — a Workers
-- isolate gives no such guarantee, and Durable Objects (the Workers-native
-- fix) are Paid-plan-only, explicitly ruled out for this deployment. This
-- migration is NOT applied automatically by this change — review and run
-- it against the live Supabase project only when actually adopting the
-- Worker deployment.
--
-- Fixed-window counter, one row per (user, route). `for update` row lock
-- makes the check-and-increment atomic across concurrent requests from the
-- same user — the one thing an in-memory Map got "for free" from running
-- single-threaded that a stateless-per-request model doesn't.
create table if not exists public.rate_limit_buckets (
  user_id      uuid not null,
  route_name   text not null,
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (user_id, route_name)
);

-- Returns true (and counts this call) if the caller is still within
-- p_max calls in the last p_window_seconds; false (uncounted) once over.
-- Same "fail closed on anything unexpected" posture as check_credits/
-- check_daily_credits elsewhere in this schema — but there is no
-- unexpected-input case here worth failing closed over (unlike a missing
-- plan_tier row), so this only ever returns based on the actual count.
create or replace function public.check_and_increment_rate_limit(
  p_user_id        uuid,
  p_route_name     text,
  p_max            integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_start timestamptz;
  v_count        integer;
begin
  select window_start, count into v_window_start, v_count
  from public.rate_limit_buckets
  where user_id = p_user_id and route_name = p_route_name
  for update;

  if not found or v_window_start <= now() - make_interval(secs => p_window_seconds) then
    insert into public.rate_limit_buckets (user_id, route_name, window_start, count)
    values (p_user_id, p_route_name, now(), 1)
    on conflict (user_id, route_name) do update
      set window_start = excluded.window_start, count = 1;
    return true;
  end if;

  if v_count >= p_max then
    return false;
  end if;

  update public.rate_limit_buckets set count = count + 1
  where user_id = p_user_id and route_name = p_route_name;
  return true;
end;
$$;

alter table public.rate_limit_buckets enable row level security;
-- No policies — zero-policy means default-deny to anon/authenticated,
-- same pattern as cortex_decisions/model_registry. All access goes
-- through the SECURITY DEFINER RPC below, called only by the service role.

revoke execute on function public.check_and_increment_rate_limit(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.check_and_increment_rate_limit(uuid, text, integer, integer) to service_role;
