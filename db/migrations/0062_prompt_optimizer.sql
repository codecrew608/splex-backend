-- 0062 — Prompt Optimizer telemetry (Pro-only feature).
--
-- Per-message outcome row for every chat turn that PASSED THROUGH the
-- optimizer decision layer — including bypassed ones (bypass_reason set,
-- was_optimized false) — mirroring cortex_decisions' own posture
-- (migration 0001): one row per real decision, insert-only, fire-and-
-- forget from the application side, service-role only. This is what makes
-- "why wasn't this optimized" and "is this actually saving money"
-- answerable from real data instead of guessed at (spec items 19/20/21).
--
-- Pro-only by product decision, not a technical restriction: the
-- optimizer only ever runs for planTier 'pro' (see
-- apps/backend/src/optimizer/decision.ts's isPlanTierEligibleForOptimization),
-- so in practice every row here belongs to a Pro user. No separate
-- feature flag exists for this table/feature — it reuses SPLEX_PRO_ENABLED,
-- the same single source of truth as every other pro_* surface, rather
-- than adding a second independent flag for one more piece of a tier
-- that is already fully gated (see pro/gate.ts).
create table public.prompt_optimizer_outcomes (
  id                     uuid primary key default gen_random_uuid(),
  message_id             uuid not null references public.messages(id) on delete cascade,
  user_id                uuid not null references auth.users(id) on delete cascade,
  was_optimized          boolean not null,
  method                 text not null check (method in ('none', 'deterministic', 'semantic')),
  bypass_reason          text,
  original_tokens_est    integer not null,
  optimized_tokens_est   integer not null,
  reduction_pct          numeric(5, 4) not null default 0,
  optimizer_model        text,
  optimizer_cost_usd     numeric(12, 8) not null default 0,
  optimizer_latency_ms   integer not null default 0,
  downstream_savings_usd numeric(12, 8) not null default 0,
  net_savings_usd        numeric(12, 8) not null default 0,
  validation_passed      boolean,
  created_at             timestamptz not null default now()
);

create index idx_prompt_optimizer_outcomes_user_id on public.prompt_optimizer_outcomes(user_id);
create index idx_prompt_optimizer_outcomes_message_id on public.prompt_optimizer_outcomes(message_id);

alter table public.prompt_optimizer_outcomes enable row level security;
-- No policies — same default-deny-except-service_role posture as
-- cortex_decisions and every other internal-bookkeeping table in this
-- schema. Cost figures and model names here are exactly the kind of
-- internal detail item 12 says must never reach a client response.
