-- Free-tier generosity pass, grounded in two live-verified facts rather
-- than assumption:
--
-- 1) Free-tier chat already routes exclusively to genuinely $0 OpenRouter
--    :free models (enforced by test/free-paid-isolation.test.ts's own
--    enumeration of every completion call site) — but credits/realCost.ts's
--    shadow-pricing still charges the pool against the CHEAPEST ACTIVE PAID
--    row in the same category, not the literal $0 it actually cost SPLEX.
--    That's a deliberate policy choice (a $0 charge would make the pool
--    meaningless), but it also means daily_requests/daily_credits/credits
--    are the actual knobs controlling how much of a genuinely-free resource
--    a Free user can use — raising them costs SPLEX nothing in reality.
--    Checked before raising: only 16 Free users and 3 user messages in the
--    last 24h platform-wide (2026-09-05) — nowhere near OpenRouter's
--    platform-wide :free-model rate ceiling (1,000/day once the account has
--    spent $10+ lifetime, which SPLEX's paying Pro users already clear).
--
-- 2) image_generations/video_generations/web_searches stay at 0 for Free —
--    verified via live research, not assumed, that none of these are
--    actually free on OpenRouter today: the web-search plugin bills ~$0.02
--    per search via Exa.ai regardless of the underlying model (documented
--    OpenRouter pricing), no image-generation model currently carries the
--    :free suffix (confirmed against OpenRouter's own free-models
--    collection), and no free video-generation model exists at all.
--    Enabling any of these for Free would be real, uncapped provider spend,
--    not the same kind of change as (1) — directly against "free things
--    only... so we also don't go bankrupt".
update plan_limits set limit_amount = 100   where plan_tier = 'free' and counter_type = 'daily_requests';
update plan_limits set limit_amount = 3000  where plan_tier = 'free' and counter_type = 'daily_credits';
update plan_limits set limit_amount = 75000 where plan_tier = 'free' and counter_type = 'credits';

-- File uploads/storage are a different cost shape entirely: self-hosted
-- OCR+embedding compute and Supabase storage bytes, not metered per-call
-- provider spend — a few hundred MB of Supabase storage is a fraction of a
-- cent per user per month. 500MB matches ChatGPT free's own published
-- Library cap exactly (live-verified, not guessed); file_uploads raised
-- proportionally so the count cap doesn't become the binding constraint
-- before the new storage cap does.
update plan_limits set limit_amount = 20        where plan_tier = 'free' and counter_type = 'file_uploads';
update plan_limits set limit_amount = 524288000 where plan_tier = 'free' and counter_type = 'storage_bytes'; -- 500 MiB

-- Unrelated data-integrity fix surfaced while researching (1) above:
-- black-forest-labs/flux.2-klein-4b was registered with variant='free', but
-- OpenRouter's real pricing for it is $0.014/first megapixel + $0.001/each
-- subsequent megapixel — not $0. It's currently is_active=false so this
-- mislabeling isn't live today, but a mislabeled 'free' variant would
-- bypass credits/realCost.ts's shadow-pricing (which only shadow-prices
-- non-'paid' variants) if it were ever reactivated as-is.
update model_registry set variant = 'paid' where openrouter_model_id = 'black-forest-labs/flux.2-klein-4b';
