-- FIX (production bug, confirmed live 2026-09-04): files_set_canonical_storage_path()
-- (introduced in migration 0028) has thrown "null character not permitted"
-- (SQLSTATE 54000) on EVERY single insert/rename since it was deployed —
-- confirmed against production by reproducing the exact failure directly.
--
-- Root cause: `replace(v_name, chr(0), '')`, intended to strip a stray NUL
-- byte from the filename before it becomes part of storage_path. Postgres
-- `text` cannot represent chr(0) AT ALL — not "a value containing one is
-- rejected", but the literal chr(0) itself cannot be constructed as a text
-- value in the first place — so this line failed unconditionally,
-- regardless of whether new.filename ever actually contained a NUL byte.
-- If it genuinely had, storing it into ANY text column (including the
-- client's own original INSERT into files.filename) would already have
-- failed with this exact error before this trigger ever ran — so there was
-- never a real NUL byte here for this line to strip in the first place.
--
-- Because this fires on every insert, EVERY file/image upload attempt on
-- the entire product has failed at this trigger since 0028 — the frontend
-- (Composer.tsx) only recognizes two specific error substrings
-- ("file_upload_limit_exceeded", "storage_limit_exceeded") to show a
-- message for; this error matched neither, so it silently fell through to
-- `continue`, and the picked file simply never appeared as an attachment
-- with no visible explanation at all.
--
-- Fix: drop the dead/broken chr(0) branch. The traversal-stripping
-- (replace(v_name, '..', '')) and everything else is untouched.
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

  -- basename only, then strip traversal, then bound the length.
  v_name := regexp_replace(coalesce(new.filename, ''), '^.*[/\\]', '');
  v_name := replace(v_name, '..', '');
  v_name := btrim(v_name);
  if v_name = '' then
    v_name := 'file';
  end if;
  v_name := left(v_name, 200);

  new.storage_path := new.user_id::text || '/' || new.id::text || '/' || v_name;
  return new;
end;
$$;
