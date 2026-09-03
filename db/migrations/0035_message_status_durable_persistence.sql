-- Durable assistant-message persistence (production hardening pass).
--
-- ROOT CAUSE this fixes: every generation path (plain chat, image/audio/ppt,
-- web search, deep research) previously called insertMessage() for the
-- assistant's row only ONCE, at the very end, after the full response was
-- already known. There was no row at all while generation was in progress.
-- If the client disconnected before that final insert ran — closing the
-- tab, refreshing, or (for anything longer than a few seconds) simply
-- navigating to another chat or Settings while a slower response was still
-- streaming — nothing was ever persisted. Returning to the conversation
-- showed the user's message with no reply: not a race that occasionally
-- loses a token, a hole where an entire row never existed.
--
-- The fix (see persistence/messages.ts, handlers/chat.ts,
-- routes/mediaGeneration.ts, research/handler.ts, research/deepResearch.ts)
-- is to insert the assistant row immediately once generation is about to
-- start — content empty, status='streaming' — and update that SAME row in
-- place when the turn finishes, however it finishes. `status` is what lets
-- the frontend (and this migration's backfill) distinguish "this row is
-- genuinely done" from "this row exists but the server never got to
-- finish it" without guessing from empty content alone.
alter table messages
  add column status text not null default 'complete';

alter table messages
  add constraint messages_status_check
  check (status in ('complete', 'streaming', 'failed'));

comment on column messages.status is
  'complete: final content persisted normally or after a clean abort/error handoff. '
  'streaming: an assistant row inserted before generation started; content may still be empty or partial — '
  'read as "this turn never finished" only for content-empty rows created before this migration is irrelevant '
  'to any row going forward, since every finalize path now sets complete/failed explicitly. '
  'failed: generation ended with nothing usable (empty model output, aborted before any content, or an '
  'unhandled exception) — content holds a short user-facing explanation, never blank.';

-- No backfill needed: every row that existed before this column did was,
-- definitionally, already fully persisted under the old insert-once-at-
-- the-end behavior, so the column default above ('complete') already
-- describes every existing row correctly.
