-- 0059 — Tier rename, STEP 1 of 3: give 'starter' the ₹299 tier's real limits.
--
-- BACKGROUND. The plan_tier enum is inverted relative to the product:
--
--     enum 'pro'     -> the ₹299 plan, shown in the UI as "Starter"  (5 live paying users)
--     enum 'starter' -> dormant, 2 stale rows, 0 users
--     enum 'free'    -> Free (19 users)
--
-- migration 0018 deliberately left it that way ("renaming a live enum
-- carries real migration risk for no user-facing benefit"). That reasoning
-- expires the moment a genuine Pro tier exists: SPLEX Pro (₹799) needs the
-- name 'pro', and it cannot have it while 5 paying ₹299 customers are
-- sitting on that value.
--
-- THE DANGER THIS STEP DEFUSES. 'starter' currently holds only two stale
-- rows — credits=5000 and daily_requests=NULL — against 'pro' which holds
-- 28 fully-configured rows (100,000 credits, 3,300 daily credits, 75
-- messages/day, and every capability quota: audio, image, video, ppt,
-- research, web_search, vision, workflow, storage, file_uploads).
-- Moving users first would instantly drop them from 100,000 to 5,000
-- credits and strip every capability. So the limits move FIRST, while
-- nobody is on 'starter' and the change is therefore unobservable.
--
-- SEQUENCE (each step safe on its own, in this order):
--   0059  copy pro's limits -> starter            (no users affected; nobody is on starter)
--   ----  deploy code: razorpay/billing write 'starter'; upgrade page reads 'starter'
--   0060  move the 5 users pro -> starter         (limits already identical: zero visible change)
--   0061  redefine 'pro' for SPLEX Pro ₹799
--
-- Deploying 0059 alone leaves production exactly as it is today.

insert into public.plan_limits (plan_tier, counter_type, limit_amount)
select 'starter'::plan_tier, counter_type, limit_amount
from public.plan_limits
where plan_tier = 'pro'
on conflict (plan_tier, counter_type) do update
  set limit_amount = excluded.limit_amount;
