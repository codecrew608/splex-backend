-- ============================================================================
-- SPLEX — Migration 0004: consume_credits() accepts real token counts
-- ============================================================================
-- Migration 0003 added real_input_tokens/real_output_tokens columns to
-- credit_usage_logs, but consume_credits() itself still only wrote
-- real_cost_estimate. Extending its signature so the backend can pass real
-- usage straight through in the same RPC call it already makes on every
-- clean completion.
--
-- Function signature changes, so the old overload is dropped first (adding
-- params with CREATE OR REPLACE alone creates a second overload instead of
-- replacing in place) and the grant/revoke from migration 0001 is reapplied
-- to the new signature.
-- ============================================================================

drop function if exists public.consume_credits(uuid, integer, text, complexity_level, text, numeric);

create or replace function public.consume_credits(
  p_user_id             uuid,
  p_credit_cost         integer,
  p_intent              text,
  p_complexity          complexity_level,
  p_openrouter_model_id text,
  p_real_cost_estimate  numeric default 0,
  p_real_input_tokens   integer default null,
  p_real_output_tokens  integer default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tier          plan_tier;
  v_credit_period date;
  v_daily_period  date;
begin
  select plan_tier into v_tier from public.users where id = p_user_id;
  v_credit_period := public.get_period_start('credits');

  insert into public.usage_counters (user_id, counter_type, period_start, used)
  values (p_user_id, 'credits', v_credit_period, p_credit_cost)
  on conflict (user_id, counter_type, period_start)
  do update set used = public.usage_counters.used + excluded.used;

  if v_tier = 'free' then
    v_daily_period := public.get_period_start('daily_requests');
    insert into public.usage_counters (user_id, counter_type, period_start, used)
    values (p_user_id, 'daily_requests', v_daily_period, 1)
    on conflict (user_id, counter_type, period_start)
    do update set used = public.usage_counters.used + 1;
  end if;

  insert into public.credit_usage_logs
    (user_id, intent, complexity, openrouter_model_id, credits_consumed, real_cost_estimate, real_input_tokens, real_output_tokens)
  values
    (p_user_id, p_intent, p_complexity, p_openrouter_model_id, p_credit_cost, p_real_cost_estimate, p_real_input_tokens, p_real_output_tokens);
end;
$$;

revoke execute on function public.consume_credits(uuid, integer, text, complexity_level, text, numeric, integer, integer) from anon, authenticated;
grant execute on function public.consume_credits(uuid, integer, text, complexity_level, text, numeric, integer, integer) to service_role;
