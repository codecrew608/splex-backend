-- Operational hardening: durable record of failed charges, plus the two
-- indexes/cleanup jobs that are genuinely load-bearing (not cosmetic).

-- ---------------------------------------------------------------------------
-- 1. credit_charge_failures — so a lost charge is recoverable, not just logged
-- ---------------------------------------------------------------------------
--
-- consumeCredits() retries the consume RPCs three times and then gives up
-- with a log line. The billable work has ALREADY happened by then (OpenRouter
-- was called and really cost money), so a persistent database blip silently
-- under-charges the user with no record anywhere that it happened — the log
-- ages out and the discrepancy becomes permanent and undetectable.
--
-- This is the durable record. A row here means "real spend occurred that the
-- counters do not reflect", which is exactly what a reconciliation needs, and
-- it can be compared against credit_usage_logs to find the gap.
--
-- Deliberately NOT an automatic retry queue: replaying a charge without
-- knowing whether the original partially applied risks double-charging the
-- user, which is worse than under-charging. This records the fact and leaves
-- the decision to a human.
create table if not exists public.credit_charge_failures (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  rpc_name     text not null,
  credit_cost  integer not null,
  intent       text,
  -- Which pool failed to move: 'monthly' (consume_credits) or
  -- 'daily' (consume_daily_credits). Both can fail independently.
  pool         text not null,
  error_message text,
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz
);

alter table public.credit_charge_failures enable row level security;
-- Zero policies: service_role only, same default-deny posture as
-- model_health and rate_limit_buckets. This is internal billing telemetry
-- and must never be readable or writable by anon/authenticated.

create index if not exists credit_charge_failures_unresolved_idx
  on public.credit_charge_failures (created_at)
  where resolved_at is null;

comment on table public.credit_charge_failures is
  'Charges that could not be applied after retries. A row means real provider spend occurred that usage_counters does not reflect. Reconcile against credit_usage_logs; do NOT auto-replay (risks double-charging).';

-- ---------------------------------------------------------------------------
-- 2. generated_media (user_id, status) — the concurrency check's exact query
-- ---------------------------------------------------------------------------
--
-- checkConcurrentMediaLimit() runs
--   where user_id = ? and kind = ? and status in ('queued','processing')
-- on EVERY media request. Without this index that is a sequential scan over
-- the user's whole media history, and it sits on the critical path before a
-- video is admitted. Not cosmetic: it grows with usage and is load-bearing
-- for a check whose correctness depends on being fast enough to run inline.
create index if not exists generated_media_user_kind_status_idx
  on public.generated_media (user_id, kind, status);

-- ---------------------------------------------------------------------------
-- 3. model_health cleanup
-- ---------------------------------------------------------------------------
--
-- record_model_health() rolls each model's counters when its window ages out,
-- but a row is never deleted — including for models long since removed from
-- model_registry. The FK already cascades on model delete, so the real growth
-- is bounded by the registry size (dozens of rows), NOT unbounded.
--
-- So this is a small, safe prune of rows whose window has been stale for a
-- long time, letting a returning model start from configured scores rather
-- than year-old observations. Deliberately a callable function, not a cron
-- job: this codebase has no scheduler, and inventing one for a table of this
-- size would be over-engineering.
create or replace function public.prune_stale_model_health(p_older_than interval default interval '30 days')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  delete from public.model_health
   where updated_at < now() - p_older_than;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.prune_stale_model_health(interval) from public, anon, authenticated;
grant execute on function public.prune_stale_model_health(interval) to service_role;

-- ---------------------------------------------------------------------------
-- 4. messages — remove the client's ability to forge assistant turns
-- ---------------------------------------------------------------------------
--
-- messages_owner_all grants ALL to the owner, so a user can INSERT rows with
-- role='assistant' into their own conversation. It is self-scoped (no other
-- user is affected), but it means stored history is not trustworthy as a
-- record of what the model actually said — it is read back into later
-- prompts as context and shown in the UI as the assistant's words.
--
-- Writes already go through the backend on the service-role client
-- (persistence/messages.ts). Verified before writing: apps/web only ever
-- SELECTs from messages. SELECT is untouched, so history still loads
-- exactly as before.
--
-- DELETE is deliberately LEFT IN PLACE. The frontend deletes conversations
-- (ChatThread.handleDelete, ConversationList), which cascades to messages,
-- and revoking it risks breaking that path for no security gain — deleting
-- one's own messages forges nothing. Only INSERT and UPDATE can fabricate
-- or rewrite a transcript, so only those are removed.
revoke insert, update on public.messages from authenticated, anon;

comment on policy messages_owner_all on public.messages is
  'Row scope only, and effectively SELECT-only for clients as of migration 0029: INSERT/UPDATE/DELETE grants were revoked so the stored transcript cannot be forged. All writes go through the backend service-role client (persistence/messages.ts).';
