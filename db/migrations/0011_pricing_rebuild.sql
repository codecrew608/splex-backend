-- Free + Pro (₹299) pricing rebuild. Per explicit product decision: reuse
-- the existing 'pro' enum value as the ₹299 tier (previously a dormant,
-- never-wired ₹599 concept) and retire 'starter' (previously the active
-- ₹299 tier) without dropping it from the plan_tier enum -- Postgres enum
-- value drops are painful/risky and unnecessary here since application
-- code simply stops referencing it. Zero real users are on 'starter' as of
-- this migration (verified live), so the defensive UPDATE below is a no-op
-- safety net, not a real data migration.
update public.users set plan_tier = 'pro' where plan_tier = 'starter';

-- New limit dimensions beyond credits/daily_requests. file_uploads is a
-- true monthly usage_counters-style dimension (handled below); projects/
-- storage_bytes/workflow_steps/workflow_cost are looked up directly from
-- plan_limits by application code or trigger functions and never get a
-- usage_counters row (project/storage are live COUNT/SUM against their own
-- tables, workflow_steps/workflow_cost are per-run caps, not accumulating
-- usage) -- see enforce_file_limits() below and
-- apps/backend/src/cortex/workflow/limits.ts.
alter type counter_type add value if not exists 'file_uploads';
alter type counter_type add value if not exists 'projects';
alter type counter_type add value if not exists 'storage_bytes';
alter type counter_type add value if not exists 'workflow_steps';
alter type counter_type add value if not exists 'workflow_cost';

-- storage_bytes needs values above int32's ~2.1B ceiling (5GB = 5,368,709,120
-- bytes) -- widened losslessly, and well within JS Number's exact-integer
-- range (2^53), so supabase-js callers reading limit_amount keep getting a
-- plain number, not a stringified bigint.
alter table public.plan_limits alter column limit_amount type bigint;

-- Free: 50,000 credits/month, 25 messages/day (up from 500 / 20).
update public.plan_limits set limit_amount = 50000 where plan_tier = 'free' and counter_type = 'credits';
update public.plan_limits set limit_amount = 25 where plan_tier = 'free' and counter_type = 'daily_requests';

-- Pro: 1,000,000 credits/month, daily_requests stays NULL (unlimited,
-- fair-use -- check_credits() only enforces daily_requests for tier='free'
-- to begin with, so this was already effectively unlimited for any
-- non-free tier; no functional change, just documented explicitly).
update public.plan_limits set limit_amount = 1000000 where plan_tier = 'pro' and counter_type = 'credits';

insert into public.plan_limits (plan_tier, counter_type, limit_amount) values
  ('free', 'file_uploads', 5),
  ('pro', 'file_uploads', 100),
  ('free', 'projects', 3),
  ('pro', 'projects', null),          -- null = unlimited, matches the pre-existing pro/daily_requests convention
  ('free', 'storage_bytes', 104857600),    -- 100 MB
  ('pro', 'storage_bytes', 5368709120),    -- 5 GB
  ('free', 'workflow_steps', 3),
  ('pro', 'workflow_steps', 10),
  ('free', 'workflow_cost', 5000),
  ('pro', 'workflow_cost', 50000)
on conflict (plan_tier, counter_type) do update set limit_amount = excluded.limit_amount;

-- Bypass-proof enforcement for files: unlike /projects, the frontend
-- inserts `files` rows directly via the Supabase browser client
-- (components/chat/Composer.tsx), scoped only by the files_owner_all RLS
-- policy -- there is no backend route in front of file-row creation. A
-- backend-only check would therefore be trivially bypassable, and a bypass
-- here has a real cost (unlimited Supabase Storage consumption), unlike
-- e.g. a free user creating extra empty projects for themselves. Hence a
-- DB-level trigger rather than application-code-only enforcement.
create or replace function public.enforce_file_limits()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tier plan_tier;
  v_count_limit bigint;
  v_storage_limit bigint;
  v_current_count bigint;
  v_current_storage bigint;
begin
  select plan_tier into v_tier from public.users where id = new.user_id;

  select limit_amount into v_count_limit
  from public.plan_limits where plan_tier = v_tier and counter_type = 'file_uploads';

  if v_count_limit is not null then
    select count(*) into v_current_count
    from public.files
    where user_id = new.user_id
      and created_at >= date_trunc('month', now() at time zone 'Asia/Kolkata');

    if v_current_count >= v_count_limit then
      raise exception 'file_upload_limit_exceeded' using errcode = 'P0001';
    end if;
  end if;

  select limit_amount into v_storage_limit
  from public.plan_limits where plan_tier = v_tier and counter_type = 'storage_bytes';

  if v_storage_limit is not null then
    select coalesce(sum(size_bytes), 0) into v_current_storage
    from public.files
    where user_id = new.user_id;

    if v_current_storage + new.size_bytes > v_storage_limit then
      raise exception 'storage_limit_exceeded' using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_files_enforce_limits on public.files;
create trigger trg_files_enforce_limits
  before insert on public.files
  for each row execute function public.enforce_file_limits();
