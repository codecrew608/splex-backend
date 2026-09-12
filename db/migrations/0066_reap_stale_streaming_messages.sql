-- 0066 — reap assistant messages stuck in 'streaming' forever.
--
-- REAL INCIDENT (2026-09-12): a plain-chat turn's whole request died
-- abnormally mid-generation (most consistent with the Cloudflare Worker
-- instance itself being killed, not a normal JS exception — handlers/
-- chat.ts's own bottom-of-function catch, written specifically to prevent
-- a message from ever being left at 'streaming' forever, never ran). The
-- assistant row stayed status='streaming', content='' indefinitely, and the
-- reserve_daily_request() reservation it made (migration 0055) was never
-- released — silently costing the user one of their daily Free/Starter
-- messages with no way to recover short of a manual database fix.
--
-- No in-process code can protect against the process itself being killed
-- out from under it. This is the out-of-band recovery layer: an
-- opportunistic sweep, in the same spirit as release_stale_media_
-- reservations() (see DEPLOYMENT.md §8 — "runs opportunistically... so it
-- is a safety net rather than a requirement"), callable ad-hoc and also
-- triggered from handlers/chat.ts on every plain-chat turn.
--
-- reserved_daily_request distinguishes which 'streaming' rows actually
-- reserved a daily_requests slot. Only chat.ts's plain-chat branch calls
-- reserveDailyRequest (see checkCredits.ts's own doc comment) — every other
-- branch that creates a 'streaming' placeholder (image, audio, ppt,
-- video, web_search, deep_research, workflow steps) does not, and must
-- never have its release_daily_request() called on its behalf: intent/
-- complexity alone cannot safely distinguish these (a "coding" turn can
-- still be diverted into the workflow branch by shouldUseWorkflow's own
-- heuristic), so this is an explicit column, not an inferred one.

begin;

alter table public.messages
  add column if not exists reserved_daily_request boolean not null default false;

comment on column public.messages.reserved_daily_request is
  'True only for the plain-chat branch (handlers/chat.ts) that called reserve_daily_request() for this turn. Read exclusively by reap_stale_streaming_messages() to decide whether a stale streaming row must also release a daily_requests reservation.';

commit;

begin;

create or replace function public.reap_stale_streaming_messages(p_stale_after interval default '5 minutes')
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_count integer := 0;
  v_row record;
begin
  for v_row in
    select m.id, p.user_id, m.reserved_daily_request
    from public.messages m
    join public.conversations c on c.id = m.conversation_id
    join public.projects p on p.id = c.project_id
    where m.status = 'streaming'
      and m.role = 'assistant'
      and m.created_at < now() - p_stale_after
    for update of m skip locked
  loop
    update public.messages
       set status = 'failed',
           content = 'Something went wrong while generating this. Please try again.'
     where id = v_row.id;

    if v_row.reserved_daily_request then
      perform public.release_daily_request(v_row.user_id);
    end if;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;

revoke execute on function public.reap_stale_streaming_messages(interval) from public, anon, authenticated;
grant execute on function public.reap_stale_streaming_messages(interval) to service_role;

commit;
