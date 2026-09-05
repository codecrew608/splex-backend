-- Lets a user set a display name (already possible via account/profile,
-- this just adds a lighter post-onboarding path — see handlers/account.ts)
-- and a profile picture. avatar_path stores the STORAGE PATH, not a full
-- URL — survives a project URL/custom-domain change; the public URL is
-- constructed client-side via supabase.storage.from('avatars').getPublicUrl.
alter table public.users add column if not exists avatar_path text;

-- No column-level grant added for authenticated — matching full_name/
-- date_of_birth's own pattern (see the live column_privileges check this
-- session already did for those), writes to this column go through the
-- backend's service-role client only (handlers/account.ts), never a
-- direct client UPDATE, for the same "one gate for all users-table
-- writes" reasoning full_name/timezone already follow.

-- Public bucket (unlike the private 'uploads' bucket for file attachments):
-- an avatar is meant to be freely displayable via a plain <img src>, not
-- gated behind a signed URL. Public buckets serve reads through Supabase's
-- own public-URL path regardless of storage.objects RLS — the policies
-- below govern INSERT/UPDATE/DELETE/authenticated-SELECT only.
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- Same folder-per-user-id convention as the existing uploads_owner_*
-- policies (storage.foldername(name)[1] = auth.uid()) — a user can only
-- write their own avatar, never anyone else's.
create policy avatars_owner_insert on storage.objects
  for insert
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy avatars_owner_update on storage.objects
  for update
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy avatars_owner_delete on storage.objects
  for delete
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy avatars_owner_select on storage.objects
  for select
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
