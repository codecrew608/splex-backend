-- Supersedes 0048's claim_subscription_slot (not edited in place — that
-- migration is already applied/committed). Two real gaps found in a
-- follow-up review:
--
-- 1) The old function claimed a slot USING the real Razorpay subscription
--    id, which meant handlers/billing.ts::createSubscription always called
--    Razorpay's Create Subscription API BEFORE the atomic claim. Under a
--    genuine race, both concurrent requests could successfully create a
--    real subscription object on Razorpay's side before only one of them
--    won the local claim — the loser was harmless (nobody ever completes
--    Checkout for it, so it can never charge) but still a real Razorpay-
--    side object that a stronger design avoids creating at all. This
--    version claims a slot (no subscription id — none exists yet) BEFORE
--    calling Razorpay, so at most one concurrent request per user ever
--    reaches the Razorpay API in the first place.
--
-- 2) The old function's reclaim set (cancelled/completed/expired/halted)
--    had no path back from 'created' — a user who opens Razorpay Checkout
--    and simply closes it without authorizing (a completely normal
--    cancellation) is left with a local row permanently stuck at
--    status='created' forever, since Razorpay never sends a webhook event
--    for a subscription nobody ever authorized. Every subsequent Upgrade
--    click would then be refused by the pre-check with no way forward.
--    Fixed with two additional reclaim conditions below, deliberately NOT
--    extended to 'authenticated' (see the function body comment for why).
drop function if exists public.claim_subscription_slot(uuid, text, text);

create or replace function public.claim_subscription_slot(p_user_id uuid)
returns boolean
language sql
volatile
set search_path = public
as $$
  insert into subscriptions (user_id, status)
  values (p_user_id, 'created')
  on conflict (user_id) do update
    set status = 'created',
        razorpay_subscription_id = null,
        razorpay_plan_id = null,
        current_start = null,
        current_end = null,
        last_event_at = null
    where subscriptions.status in ('cancelled', 'completed', 'expired', 'halted')
       -- A prior claim that never got as far as a successful Razorpay API
       -- call (createRazorpaySubscription failed, or the process crashed
       -- between the claim and recording the id). NOT immediately
       -- reclaimable, on purpose: this exact state (status='created',
       -- razorpay_subscription_id null) is indistinguishable from a claim
       -- that is CURRENTLY in flight, a moment away from calling Razorpay
       -- — an immediate reclaim would let a second concurrent request
       -- steal the slot out from under the first between "claim commits"
       -- and "Razorpay call completes", reopening exactly the race this
       -- function exists to close. A short buffer is enough: a real
       -- Razorpay API call (network + Razorpay's own processing) resolves
       -- in well under this window, so anything still null after it is
       -- genuinely abandoned, not just slow.
       or (
         subscriptions.status = 'created'
         and subscriptions.razorpay_subscription_id is null
         and subscriptions.updated_at < now() - interval '2 minutes'
       )
       -- A prior claim that DID reach Razorpay but was then abandoned by
       -- the user (closed Checkout without authorizing). Razorpay's side
       -- has a real, still-open subscription object that could in theory
       -- still be completed for a while, so this gets a generous buffer
       -- rather than being immediately reclaimable — updated_at is bumped
       -- by the existing trg_subscriptions_updated_at trigger, so it
       -- reflects when this claim was (re)made. Deliberately NOT applied
       -- to 'authenticated': that status means a payment mandate may
       -- already be authorized, and abandoning it to create a second one
       -- risks double-billing if both ever charge — created has no such
       -- risk, since no mandate exists yet at all.
       or (
         subscriptions.status = 'created'
         and subscriptions.razorpay_subscription_id is not null
         and subscriptions.updated_at < now() - interval '30 minutes'
       )
  returning true;
$$;

revoke all on function public.claim_subscription_slot(uuid) from public, anon, authenticated;
grant execute on function public.claim_subscription_slot(uuid) to service_role;
