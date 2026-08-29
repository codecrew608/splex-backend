-- Adds the two fields collected by the first-login onboarding step
-- (frontend: components/onboarding/OnboardingModal.tsx, gated in
-- app/(app)/layout.tsx; backend: POST /account/profile). Both nullable —
-- existing users have neither until they next log in and complete it.
-- full_name IS NULL is the signal the layout uses to decide whether to
-- show the onboarding modal at all, so no separate "onboarded" boolean is
-- needed.
alter table public.users
  add column if not exists full_name text,
  add column if not exists date_of_birth date;

-- Sanity bound only (NOT an age gate or compliance mechanism) — rejects
-- obviously-wrong input at the DB level as a backstop under the app-layer
-- validation that already runs in routes/account.ts and
-- worker/routes/account.ts.
--
-- Deliberately uses a FIXED upper bound rather than `current_date`: a
-- CHECK constraint expression must be immutable, and current_date /
-- now() are only STABLE, so Postgres rejects the whole ALTER with
-- "functions in check constraint must be marked IMMUTABLE". The original
-- version of this migration had exactly that defect and would have failed
-- on apply. The real "not in the future" rule lives in the app layer
-- (both account routes reject future dates and enforce a minimum age),
-- which is where a rule that depends on today's date belongs anyway — a
-- date-dependent CHECK would also silently re-validate every existing row
-- on future table rewrites.
--
-- Wrapped in a guard so re-running this migration is a no-op; plain
-- `add constraint` errors if it already exists, unlike `add column if not
-- exists` above.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'users_date_of_birth_reasonable'
      and conrelid = 'public.users'::regclass
  ) then
    alter table public.users
      add constraint users_date_of_birth_reasonable
      check (
        date_of_birth is null
        or (date_of_birth >= date '1900-01-01' and date_of_birth <= date '2125-01-01')
      );
  end if;
end $$;

-- PostgREST caches the schema; without this, the new columns keep
-- returning PGRST204 ("Could not find the 'date_of_birth' column ... in
-- the schema cache") from the REST API even though the ALTER succeeded.
notify pgrst, 'reload schema';
