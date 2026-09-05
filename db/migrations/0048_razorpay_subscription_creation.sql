-- Atomic "claim a subscription slot" primitive for POST /billing/create-
-- subscription (handlers/billing.ts::createSubscription). Guards the exact
-- race the spec calls out: two simultaneous Upgrade requests from the same
-- user must never both succeed in creating a subscription.
--
-- A plain "SELECT status, then INSERT/UPDATE" in application code has a
-- real TOCTOU window between the check and the write. Postgres's own
-- INSERT ... ON CONFLICT ... DO UPDATE ... WHERE is atomic with respect to
-- the unique constraint on subscriptions.user_id: under true concurrent
-- execution, one caller's statement always sees the other's committed
-- effect (or lack of it) for the same conflicting row, never both
-- "seeing no row" at once — the same class of guarantee this codebase's
-- credit RPCs (reserve_daily_credits, etc.) already rely on for exactly
-- this kind of problem.
--
-- Semantics: succeeds (returns the new status) if no row exists yet for
-- this user, OR if the existing row is in a terminal state (cancelled/
-- completed/expired/halted) — a returning, previously-cancelled user can
-- resubscribe, reusing the same one-row-per-user shape the fake checkout
-- already established. Refuses (returns NULL, zero rows affected) if the
-- existing row is created/authenticated/active/pending — an existing
-- subscription already in flight or live.
create or replace function public.claim_subscription_slot(
  p_user_id uuid,
  p_razorpay_subscription_id text,
  p_razorpay_plan_id text
) returns subscription_status
language sql
volatile
set search_path = public
as $$
  insert into subscriptions (user_id, razorpay_subscription_id, razorpay_plan_id, status)
  values (p_user_id, p_razorpay_subscription_id, p_razorpay_plan_id, 'created')
  on conflict (user_id) do update
    set razorpay_subscription_id = excluded.razorpay_subscription_id,
        razorpay_plan_id = excluded.razorpay_plan_id,
        status = 'created',
        current_start = null,
        current_end = null,
        last_event_at = null
    where subscriptions.status in ('cancelled', 'completed', 'expired', 'halted')
  returning status;
$$;

-- This project has a default-privileges rule that auto-grants EXECUTE on
-- new public-schema functions directly to anon/authenticated (confirmed
-- live via information_schema.routine_privileges — revoking from PUBLIC
-- alone left both with a direct grant, same class of gap 0043 closed for
-- trigger functions). This one writes billing state, so both must be
-- revoked explicitly — only the backend's service-role client calls it.
revoke all on function public.claim_subscription_slot(uuid, text, text) from public, anon, authenticated;
grant execute on function public.claim_subscription_slot(uuid, text, text) to service_role;
