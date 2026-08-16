-- ============================================================================
-- SPLEX — Migration 0001
-- ============================================================================
-- Two things in one migration because the second was discovered while
-- preparing the first, and both touch access control on internal-only data:
--
-- PART A — SECURITY FIX (applies to the schema as already deployed):
--   model_registry, plan_limits, and credit_cost_bands were created without
--   RLS enabled. Supabase's default schema grants give anon/authenticated
--   full SELECT/INSERT/UPDATE/DELETE on every public table unless RLS turns
--   that off. Verified live: `set role anon; select * from model_registry;`
--   returned all 15 rows, including real openrouter_model_id values — a
--   direct violation of "never expose the real model/provider name" — and
--   the same gap made plan_limits/credit_cost_bands anon-WRITABLE, not just
--   readable, despite the original schema comment calling them "safe to
--   read" (read was the intent; write never was).
--
--   Fix: model_registry gets RLS enabled with zero policies (same pattern
--   as payment_events — default-deny for anon/authenticated, service_role
--   bypasses RLS entirely so the backend is unaffected). plan_limits and
--   credit_cost_bands get RLS enabled with a SELECT-only policy, so they
--   stay publicly readable (as intended) but lose anon/authenticated write
--   access.
--
-- PART B — cortex_decisions table:
--   The original spec calls for an expandable Cortex reasoning panel
--   showing intent / complexity / capabilities detected / category /
--   reason, with the real model name always stripped before it reaches the
--   client. The deployed schema only carries intent/complexity/routed_model
--   on `messages` — nowhere to persist capabilities or the reason string.
--   Adding cortex_decisions (1:1 with an assistant message) so that data
--   persists and old messages' reasoning stays inspectable later, not just
--   computed transiently per-request.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- PART A — RLS fixes
-- ---------------------------------------------------------------------------

alter table public.model_registry enable row level security;
-- Intentionally zero policies: default-deny for anon/authenticated via
-- PostgREST. service_role bypasses RLS entirely (Supabase grants it
-- BYPASSRLS), so the Fastify backend's service-role client is unaffected.

alter table public.plan_limits enable row level security;
create policy "plan_limits_public_read" on public.plan_limits
  for select using (true);

alter table public.credit_cost_bands enable row level security;
create policy "credit_cost_bands_public_read" on public.credit_cost_bands
  for select using (true);


-- ---------------------------------------------------------------------------
-- PART B — cortex_decisions
-- ---------------------------------------------------------------------------

create table public.cortex_decisions (
  id               uuid primary key default gen_random_uuid(),
  message_id       uuid not null unique references public.messages(id) on delete cascade,
  intent           text,
  complexity       complexity_level,
  capabilities     jsonb not null default '[]'::jsonb,  -- e.g. '["code_generation","reasoning"]'
  category         text,                                 -- matches model_registry.category
  reason           text,                                 -- human-readable "why this route" for the panel
  model_selected   text,                                  -- REAL openrouter_model_id. INTERNAL ONLY.
  created_at       timestamptz not null default now()
);

create index idx_cortex_decisions_message_id on public.cortex_decisions(message_id);

alter table public.cortex_decisions enable row level security;
-- Same default-deny pattern as model_registry/payment_events: zero policies,
-- service_role only. The client-facing Cortex panel payload must be built
-- server-side with model_selected stripped before it ever reaches the user
-- — never query this table directly from anon/authenticated context.
