-- ============================================================================
-- SPLEX — Migration 0003: percentage-based credit gating + real token tracking
-- ============================================================================
-- Root cause of the "new users show credits exhausted" bug: credit_cost_bands
-- held FIXED absolute numbers (complex = 700-1500 min_credits) that were
-- never cross-checked against plan_limits' per-tier totals. Free tier's
-- entire monthly allowance is 500 credits — so a brand-new free user whose
-- very first message classified as "complex" got charged 700 against a 500
-- cap and was blocked before using anything.
--
-- Fix, per explicit product decision this session:
--   1. credit_cost_bands now stores a PERCENTAGE of the caller's own plan's
--      monthly credit total, not an absolute number. The pre-flight
--      check_credits() gate estimate is computed as
--      ceil(plan_total * min_percent / 100) — this scales to every tier
--      automatically and structurally guarantees every plan can always
--      afford at least several complex-classified requests from a fresh
--      pool, forever, without needing to hand-tune absolute numbers again
--      whenever a tier's total changes.
--   2. SPLEX Credits are explicitly NOT a fixed 1:1 mapping to real model
--      tokens — real input/output token counts are tracked separately
--      (credit_usage_logs gets real_input_tokens/real_output_tokens), and
--      the ACTUAL credits charged (post-generation, via consume_credits)
--      are computed by the backend from real usage x the category's real
--      (or shadow-paid, for free-tier requests) per-token cost, converted
--      to credits at a fixed backend-configured rate. See
--      apps/backend/src/credits/realCost.ts.
--   3. category_expected_allocation is added purely for future analytics /
--      cost-and-rate-management dashboards (Phase 3+) — it is NEVER an
--      enforcement gate. check_credits() only ever looks at the aggregate
--      monthly total (already true before this migration); a user can spend
--      their whole pool on one category and nothing blocks them from doing
--      so, by design.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. credit_cost_bands: absolute -> percentage-of-plan-total
-- ---------------------------------------------------------------------------

alter table public.credit_cost_bands add column min_percent numeric(5,2);
alter table public.credit_cost_bands add column max_percent numeric(5,2);

update public.credit_cost_bands set min_percent = 2,  max_percent = 4,  description = 'Rewrite text, small questions, translation, basic explanations'  where complexity = 'simple';
update public.credit_cost_bands set min_percent = 5,  max_percent = 8,  description = 'Coding help, document summary, research, detailed explanations' where complexity = 'medium';
update public.credit_cost_bands set min_percent = 10, max_percent = 15, description = 'Large code generation, architecture design, deep analysis, large documents' where complexity = 'complex';

alter table public.credit_cost_bands alter column min_percent set not null;
alter table public.credit_cost_bands alter column max_percent set not null;
alter table public.credit_cost_bands drop column min_credits;
alter table public.credit_cost_bands drop column max_credits;

-- Invariant check: complex must never exceed a modest slice of ANY tier's
-- total, so "at least some complex tasks" is always affordable from a fresh
-- monthly pool. 15% means every tier can always run >=6 complex requests
-- back to back before exhausting an otherwise-untouched pool.
do $$
begin
  if (select max_percent from public.credit_cost_bands where complexity = 'complex') > 20 then
    raise exception 'complex band max_percent too high — would risk re-introducing the exhaustion bug';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. credit_usage_logs: track real token counts separately from credits
-- ---------------------------------------------------------------------------

alter table public.credit_usage_logs add column real_input_tokens integer;
alter table public.credit_usage_logs add column real_output_tokens integer;


-- ---------------------------------------------------------------------------
-- 3. category_expected_allocation: analytics-only reference data, never a gate
-- ---------------------------------------------------------------------------

create table public.category_expected_allocation (
  plan_tier        plan_tier not null,
  category         text not null,
  expected_percent numeric(5,2) not null,
  primary key (plan_tier, category)
);

alter table public.category_expected_allocation enable row level security;
create policy "category_expected_allocation_public_read" on public.category_expected_allocation
  for select using (true);

-- Same expected mix across all tiers for now (proportional to whatever the
-- tier's total happens to be) — tune per-tier later once real usage data
-- exists. Sums to 100 per tier. general/coding/reasoning+math/documents/
-- writing/vision map onto model_registry's 7 categories.
insert into public.category_expected_allocation (plan_tier, category, expected_percent)
select t.plan_tier, c.category, c.expected_percent
from (values ('free'::plan_tier), ('starter'::plan_tier), ('pro'::plan_tier)) as t(plan_tier)
cross join (values
  ('general',   40),
  ('coding',    25),
  ('reasoning', 10),
  ('math',       5),
  ('documents', 10),
  ('writing',    5),
  ('vision',     5)
) as c(category, expected_percent);
