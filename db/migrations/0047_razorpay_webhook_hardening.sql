-- Prepares the existing subscriptions/payment_events schema for the real
-- Razorpay webhook (handlers/razorpay.ts) alongside the current fake
-- checkout (handlers/billing.ts) — no parallel billing schema introduced.

-- 1) A webhook-driven upsert has no prior local row to inherit
--    razorpay_customer_id from when a subscription's very first lifecycle
--    event (subscription.authenticated) arrives before Razorpay's entity
--    payload reliably carries a customer_id. The fake checkout and any
--    future create-subscription flow continue to always supply one.
alter table public.subscriptions
  alter column razorpay_customer_id drop not null;

-- 2) One Razorpay subscription must never be linked to more than one SPLEX
--    user — without this, a bug or race in user-association could let a
--    second user's row claim an existing paid subscription.
create unique index if not exists subscriptions_razorpay_subscription_id_key
  on public.subscriptions (razorpay_subscription_id)
  where razorpay_subscription_id is not null;

-- 3) Out-of-order webhook delivery guard: a state transition only applies
--    if it's newer than the last one actually applied to that row.
--    Populated from each Razorpay event's own top-level created_at.
alter table public.subscriptions
  add column if not exists last_event_at timestamptz;

-- 4) Defense-in-depth, matching 0041/0043's established pattern: RLS
--    already default-denies these for anon/authenticated in practice
--    (subscriptions has a SELECT-only owner policy; payment_events has
--    zero policies at all) — explicit REVOKEs mean a future RLS policy
--    mistake can't silently reopen client write access to billing state.
--    Billing state stays server-authoritative (service_role only).
--    subscriptions keeps its SELECT grant — subscriptions_owner_select
--    legitimately depends on it for a user reading their own row.
revoke insert, update, delete, truncate, references, trigger
  on public.subscriptions from anon, authenticated;

-- payment_events is an internal audit/idempotency log with zero client-
-- facing policies of any kind, so its SELECT grant is revoked too.
revoke insert, update, delete, select, truncate, references, trigger
  on public.payment_events from anon, authenticated;
