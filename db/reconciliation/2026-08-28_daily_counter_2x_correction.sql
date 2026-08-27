-- ============================================================================
-- RECONCILIATION — daily_credits counter, 2x overcharge correction
--
-- NOT a migration. Run MANUALLY, by a human, AFTER the fixed Worker is
-- deployed. Deliberately kept out of db/migrations/ so it can never be
-- replayed automatically against a database it has already been applied to.
-- ============================================================================
--
-- WHAT HAPPENED
--   Between migration 0022 landing (20260823164341) and the skipDaily fix,
--   every reserving path charged the daily counter three times over:
--     reserve(estimate) + consume(actual) + settle(actual - estimate)
--       = 2 x actual
--   The monthly pool and credit_usage_logs were NEVER affected, so the
--   ledger is authoritative and can be used to rebuild the counter.
--
-- SCOPE (verified against production 2026-08-28)
--   exact  : 15 rows  (counter already equals the ledger — untouched)
--   OVER   :  1 row   (+69 credits) <- the only thing this script corrects
--   UNDER  :  3 rows  (-294 total, 2026-08-21..23)
--
-- WHY UNDER-COUNTED ROWS ARE DELIBERATELY LEFT ALONE
--   They pre-date the daily counter being wired up and are unrelated to the
--   2x bug. "Correcting" them means retroactively charging users MORE for
--   days that closed a week ago, with no benefit to anyone. Leaving them is
--   the conservative choice; raise it explicitly if you disagree.
--
-- ORDER OF OPERATIONS — THIS MATTERS
--   Deploy the fixed Worker FIRST. The double-charge is still live in
--   production until then, so running this beforehand just lets fresh drift
--   accrue on top of a freshly corrected counter.
--
-- IMPACT NOTE
--   daily_credits resets per IST day. The only affected row is 2026-08-27,
--   which is already in the past, so this does not unblock anyone today —
--   it restores historical accuracy. It is safe, but it is not urgent.

begin;

-- 1. Snapshot before touching anything, so the change is reversible.
create table if not exists public._recon_daily_counter_20260828 as
select uc.*, now() as snapshot_taken_at
from public.usage_counters uc
where uc.counter_type = 'daily_credits';

-- 2. Preview (should print exactly one row: 240a9dab… 2026-08-27, 138 -> 69).
with ledger as (
  select user_id, ((created_at at time zone 'Asia/Kolkata')::date) as day,
         sum(credits_consumed)::int as truth
  from public.credit_usage_logs group by 1,2
)
select uc.user_id, uc.period_start, uc.used as before_value, l.truth as after_value
from public.usage_counters uc
join ledger l on l.user_id = uc.user_id and l.day = uc.period_start
where uc.counter_type = 'daily_credits' and uc.used > l.truth;

-- 3. Apply. Only ever lowers a counter to the ledger truth; `used > truth`
--    means an over-counted row can never be raised by this statement.
with ledger as (
  select user_id, ((created_at at time zone 'Asia/Kolkata')::date) as day,
         sum(credits_consumed)::int as truth
  from public.credit_usage_logs group by 1,2
)
update public.usage_counters uc
   set used = l.truth
  from ledger l
 where uc.counter_type = 'daily_credits'
   and l.user_id = uc.user_id
   and l.day = uc.period_start
   and uc.used > l.truth;

-- 4. Verify: this must return ZERO rows before you commit.
with ledger as (
  select user_id, ((created_at at time zone 'Asia/Kolkata')::date) as day,
         sum(credits_consumed)::int as truth
  from public.credit_usage_logs group by 1,2
)
select uc.user_id, uc.period_start, uc.used, l.truth
from public.usage_counters uc
join ledger l on l.user_id = uc.user_id and l.day = uc.period_start
where uc.counter_type = 'daily_credits' and uc.used > l.truth;

-- Inspect the output of steps 2 and 4, then:
commit;
-- rollback;  -- use this instead if anything looks wrong

-- ROLLBACK AFTER COMMIT (if ever needed):
--   update public.usage_counters uc
--      set used = s.used
--     from public._recon_daily_counter_20260828 s
--    where s.id = uc.id;
--
-- Drop the snapshot once you are satisfied:
--   drop table public._recon_daily_counter_20260828;
