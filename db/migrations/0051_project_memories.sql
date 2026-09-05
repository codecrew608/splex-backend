-- Project-scoped memory, mirroring user_memories (migration 0037) exactly
-- in shape and access pattern, scoped to project_id instead of user_id:
-- structured key/fact rows (not a blob) so a restated fact upserts in
-- place and an explicit "forget X" is a real delete, not asked of a
-- summarization model to edit out of a paragraph.
--
-- Ownership isn't a direct column here (no project_memories.user_id) —
-- it's via project_id -> projects.user_id, so RLS and grants both need
-- that join rather than a simple auth.uid() = user_id check.
create table public.project_memories (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  fact_key text not null,
  fact text not null,
  source_message_id uuid references public.messages(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, fact_key)
);

create index idx_project_memories_project_id on public.project_memories(project_id);

alter table public.project_memories enable row level security;

-- Same shape as user_memories: the owner can view/delete their own facts
-- directly (a future Project settings page could offer the same "manage
-- memory" UI user_memories already has) — but INSERT/UPDATE have no policy
-- at all. Extraction always runs through the backend's service-role
-- client (extractAndUpdateMemory), never client-writable, matching that
-- function's own stated invariant for user_memories.
create policy project_memories_select_own on public.project_memories
  for select
  using (project_id in (select id from public.projects where user_id = (select auth.uid())));

create policy project_memories_delete_own on public.project_memories
  for delete
  using (project_id in (select id from public.projects where user_id = (select auth.uid())));

-- Explicit, minimal grants from the start (matching user_memories' own
-- live grants exactly: authenticated has only SELECT+DELETE, anon has
-- nothing) rather than relying on whatever this project's default
-- privileges would hand out otherwise — see migration 0048's own comment
-- for why that default isn't safe to assume.
revoke all on public.project_memories from public, anon, authenticated;
grant select, delete on public.project_memories to authenticated;
