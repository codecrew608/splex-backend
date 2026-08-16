-- ============================================================================
-- SPLEX — Migration 0005: phase-2 schema (conversations.title, files.extracted_text,
-- uploads Storage bucket + RLS)
-- ============================================================================
-- Enables: real multi-chat Projects (conversations need their own title once
-- a project can hold >1 chat — today's title is borrowed from the parent
-- project, which only worked because every conversation got a dedicated 1:1
-- project), and basic file attachment (extracted_text caches parsed
-- text so a file isn't re-parsed on every reference; the uploads bucket +
-- storage RLS enforce owner-only access via the {user_id}/{file_id}/{filename}
-- path convention).
-- ============================================================================

alter table public.conversations add column title text;
update public.conversations c set title = p.title
  from public.projects p where p.id = c.project_id and c.title is null;
alter table public.conversations alter column title set default 'New chat';
alter table public.conversations alter column title set not null;

alter table public.files add column extracted_text text;

insert into storage.buckets (id, name, public) values ('uploads', 'uploads', false);

create policy "uploads_owner_select" on storage.objects for select
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "uploads_owner_insert" on storage.objects for insert
  with check (bucket_id = 'uploads' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "uploads_owner_delete" on storage.objects for delete
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] = auth.uid()::text);
