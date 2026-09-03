-- Structured per-fact user memory, replacing the single free-text blob
-- (user_memory.summary_text) as the CANONICAL store going forward.
--
-- user_memory is NOT dropped -- it holds real, already-accumulated data
-- for existing users, and migrating it would require an LLM call per user
-- (this project's own convention: no live paid-provider calls from a
-- migration). The backend now reads it only as a fallback when a user has
-- no rows here yet (see memory/extractMemory.ts and handlers/chat.ts),
-- and the Memory settings page still surfaces it, separately, with its
-- own clear action -- nobody's existing memory silently disappears.
--
-- Why a new table rather than patching the blob in place: "delete an
-- individual memory" (a real product requirement) has no honest
-- implementation against one free-text field -- you can't cleanly excise
-- one fact from a paragraph an LLM wrote. Individual rows make that a
-- plain DELETE.
create table user_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Short, stable identifier the extraction model assigns consistently
  -- (e.g. "name", "preference:response_length", "project:current") so
  -- restating or updating the same fact overwrites the existing row
  -- (via the unique constraint below + an upsert) instead of
  -- accumulating duplicates every time it comes up again.
  fact_key text not null,
  fact text not null,
  -- Best-effort provenance (which message this was extracted from) --
  -- not a hard requirement for every row (a user-authored edit via the
  -- Memory page, if ever added, would have none), hence nullable.
  source_message_id uuid references messages(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, fact_key)
);

create index idx_user_memories_user_id on user_memories(user_id);

alter table user_memories enable row level security;

-- Read and delete only -- deliberately no policy (and no GRANT below) for
-- INSERT/UPDATE. Every fact is written by the server (service_role,
-- bypasses RLS) via the extraction pipeline, which is what stops the
-- model — or a client calling the REST API directly — from inventing or
-- silently rewriting a memory with no server-side judgment involved.
-- "Delete" (single row and "clear all") is the one write a user makes
-- directly, same precedent as this app's existing direct-client-DELETE
-- patterns (own conversations, own files).
create policy user_memories_select_own on user_memories for select using (auth.uid() = user_id);
create policy user_memories_delete_own on user_memories for delete using (auth.uid() = user_id);

revoke all on user_memories from anon, authenticated;
grant select, delete on user_memories to authenticated;
-- Deliberately nothing granted to anon: memory is never readable or
-- writable without a session, matching every other per-user table in
-- this schema (see files/conversations for the same pattern).
