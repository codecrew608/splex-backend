-- 0067 — SPLEX Pro launch mechanism: a DB-backed feature flag the admin
-- board can flip instantly (no redeploy), plus an in-app announcement
-- surface for launch messages.
--
-- Replaces SPLEX_PRO_ENABLED (a static, deploy-time Worker config var) as
-- the actual gate pro/gate.ts checks. SPLEX_PRO_ENABLED itself stays
-- declared in both env schemas (harmless, no longer consulted) rather than
-- being ripped out in the same change that's already touching several
-- files.
--
-- Ships disabled: the seed row below is 'pro_enabled' = false, same
-- default posture this codebase has held since Pro's foundation migration
-- (0061). Nothing about applying this migration changes Pro's
-- reachability — that only happens when an operator flips the row via the
-- admin board.

begin;

create table if not exists public.system_flags (
  key        text primary key,
  enabled    boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.system_flags enable row level security;
-- No policies — RLS enabled with zero policies denies every role except
-- service_role, matching provider_free_model_capacity/
-- openrouter_credential_health's posture. Read by the Worker's own
-- supabaseAdmin client (service role); written only by the admin board's
-- direct PostgREST call using the service-role key. Never reachable by
-- anon/authenticated.

insert into public.system_flags (key, enabled)
values ('pro_enabled', false)
on conflict (key) do nothing;

create table if not exists public.announcements (
  id         uuid primary key default gen_random_uuid(),
  message    text not null,
  created_at timestamptz not null default now(),
  active     boolean not null default true
);

alter table public.announcements enable row level security;

-- Signed-in users only, and only currently-active announcements — matches
-- every other user-facing table's owner/authenticated read pattern in
-- this schema. No insert/update/delete grant for anon/authenticated: only
-- the admin board (service role) ever writes a row.
create policy announcements_read on public.announcements
  for select
  to authenticated
  using (active);

commit;
