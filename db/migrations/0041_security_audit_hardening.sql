-- Security-audit pass (2026-09-04), findings from Supabase's own advisor.
--
-- 1. Four functions had no fixed search_path — a function without one is
--    vulnerable to "search_path hijacking" (a caller who can create an
--    object earlier in their session's search_path could get the function
--    to resolve an unqualified name to their own object instead of the
--    real one). migration 0028's functions already got this right; these
--    four predate that pattern.
alter function public.bump_updated_at() set search_path = public;
alter function public.get_period_start(counter_type) set search_path = public;
alter function public.prune_old_usage_counters() set search_path = public;
alter function public.match_file_chunks(uuid, vector, integer) set search_path = public;

-- 2. Three SECURITY DEFINER trigger functions (enforce_file_limits,
--    files_set_canonical_storage_path, handle_new_auth_user) still carried
--    their default EXECUTE grant to anon/authenticated, making them
--    directly callable via /rest/v1/rpc/<name> — not actually exploitable
--    (Postgres refuses to invoke a `returns trigger` function outside
--    trigger context, verified), but there's no reason to leave an unused
--    RPC surface sitting there. Trigger invocation itself is entirely
--    separate from and unaffected by revoking direct EXECUTE.
revoke execute on function public.enforce_file_limits() from anon, authenticated;
revoke execute on function public.files_set_canonical_storage_path() from anon, authenticated;
revoke execute on function public.handle_new_auth_user() from anon, authenticated;

-- 3. Stale one-off reconciliation snapshot (db/reconciliation/2026-08-28_
--    daily_counter_2x_correction.sql) — served its purpose, has RLS
--    enabled with no policies (so already inert to any client role) and
--    no primary key. Dropping it removes leftover schema cruft rather
--    than leaving it to be mistaken for something still in use.
drop table if exists public._recon_daily_counter_20260828;
