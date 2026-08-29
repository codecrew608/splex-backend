-- SECURITY: stop the client writing the security-relevant columns on files.
--
-- THE VULNERABILITY (same shape as migration 0026's plan_tier bypass)
--
-- files_owner_all scopes ROWS (auth.uid() = user_id); the `authenticated`
-- role held column-level INSERT and UPDATE on EVERY column, so the client
-- chose the value of each one. RLS restricts which rows may be written, not
-- which columns.
--
--   storage_path   -> P0. The backend downloads this path with the
--                     SERVICE-ROLE client, which bypasses Storage RLS
--                     entirely. A user could point their own files row at
--                     another user's object and have the backend fetch it,
--                     extract its text, and store it where they could read
--                     it. (Storage RLS itself is correct — it just never
--                     applies to a service-role call.)
--   size_bytes     -> enforce_file_limits() sums this column for the
--                     storage quota, so a false value understates usage
--                     permanently.
--   extracted_text -> lets a user forge "file contents" that are later fed
--                     into their own prompts, so stored text carried no
--                     provenance.
--   user_id / id   -> identity of the row itself.
--
-- THE FIX
--
-- Column-level GRANTs, enforced independently of RLS (the 0026 pattern).
-- The client keeps exactly the columns it legitimately supplies, and the
-- database itself produces the rest.
--
-- Defaults + a trigger are required because storage_path, size_bytes and
-- user_id are all NOT NULL: revoking INSERT without supplying a value would
-- simply break every upload.

-- 1. The database, not the client, decides who owns a row.
alter table public.files alter column user_id set default auth.uid();

-- 2. Real size is measured server-side at process time from the downloaded
--    object (handlers/files.ts). 0 is the honest starting value — a claim
--    the client cannot make.
alter table public.files alter column size_bytes set default 0;

-- 3. Placeholder so the NOT NULL constraint is satisfiable; the trigger
--    below overwrites it with the canonical value on every write.
alter table public.files alter column storage_path set default '';

-- 4. Canonical, server-computed storage path: <user_id>/<id>/<filename>.
--
-- Mirrors sanitizeStoredFilename() in apps/backend/src/files/storagePath.ts
-- so both layers agree byte-for-byte. Separators and traversal are stripped
-- rather than escaped — neither has any legitimate place in an object name.
--
-- On UPDATE the original path is pinned: a stored object must never be
-- re-pointed after the fact, and renaming a file must not orphan its object.
create or replace function public.files_set_canonical_storage_path()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  if tg_op = 'UPDATE' then
    new.storage_path := old.storage_path;
    new.user_id := old.user_id;
    new.id := old.id;
    return new;
  end if;

  -- basename only, then strip traversal and NULs, then bound the length
  v_name := regexp_replace(coalesce(new.filename, ''), '^.*[/\\]', '');
  v_name := replace(replace(v_name, '..', ''), chr(0), '');
  v_name := btrim(v_name);
  if v_name = '' then
    v_name := 'file';
  end if;
  v_name := left(v_name, 200);

  new.storage_path := new.user_id::text || '/' || new.id::text || '/' || v_name;
  return new;
end;
$$;

-- BEFORE the existing trg_files_enforce_limits (names sort earlier), so the
-- quota trigger sees the final row. Both are BEFORE-row triggers and
-- Postgres fires them in name order.
drop trigger if exists trg_files_canonical_path on public.files;
create trigger trg_files_canonical_path
  before insert or update on public.files
  for each row execute function public.files_set_canonical_storage_path();

-- 5. Revoke blanket write, then re-grant ONLY what the browser genuinely
--    supplies at upload time.
revoke insert, update on public.files from authenticated, anon;

-- filename/file_type/mime_type/project_id: real user-supplied metadata.
-- processing_status: the client sets the initial 'uploaded' value.
grant insert (filename, file_type, mime_type, project_id, processing_status)
  on public.files to authenticated;

-- Renaming and re-filing are legitimate; nothing security-relevant is here.
-- storage_path/user_id/id are additionally pinned by the trigger above, so
-- even a future accidental grant cannot move them.
grant update (filename, project_id)
  on public.files to authenticated;

-- DELETE is unchanged: files_owner_all still lets an owner remove their own
-- rows, and the storage object is cleaned up separately.

comment on policy files_owner_all on public.files is
  'Row scope only. Column scope is enforced by GRANTs (migration 0028): the client may insert filename/file_type/mime_type/project_id/processing_status and update filename/project_id. storage_path, size_bytes, extracted_text, user_id and id are database- or service-role-owned — client control of storage_path allowed a cross-tenant read via the service-role Storage client.';
