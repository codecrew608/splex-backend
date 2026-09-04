-- FIX: 0041's revoke on enforce_file_limits/files_set_canonical_storage_path/
-- handle_new_auth_user targeted anon/authenticated directly, but Postgres
-- grants EXECUTE to the PUBLIC pseudo-role by default at function creation
-- — every role (including anon/authenticated) inherits from PUBLIC, so that
-- grant alone still made these three directly callable via
-- /rest/v1/rpc/<name>. Revoking from PUBLIC removes the actual source of
-- the privilege. Verified against Supabase's own security advisor: the
-- anon_security_definer_function_executable /
-- authenticated_security_definer_function_executable findings for all
-- three functions are gone after this, not just assumed fixed.
revoke execute on function public.enforce_file_limits() from public;
revoke execute on function public.files_set_canonical_storage_path() from public;
revoke execute on function public.handle_new_auth_user() from public;
