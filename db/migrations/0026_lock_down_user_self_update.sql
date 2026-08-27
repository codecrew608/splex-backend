-- SECURITY: stop a user from granting themselves a paid plan.
--
-- THE VULNERABILITY
--
-- public.users has an RLS policy `users_update_own`:
--     UPDATE ... USING (auth.uid() = id)
-- and the `authenticated` role holds column-level UPDATE on EVERY column of
-- that table, including plan_tier. RLS restricts WHICH ROWS may be updated;
-- it does not restrict WHICH COLUMNS. Nothing else stood in the way — the
-- only trigger on the table is bump_updated_at.
--
-- So any signed-in user could run this straight from the browser client and
-- upgrade themselves to the paid tier for free:
--
--     supabase.from('users').update({ plan_tier: 'pro' }).eq('id', <own id>)
--
-- Every entitlement in the product derives from users.plan_tier — credits,
-- daily caps, model variant (paid vs :free), web search, deep research,
-- audio/video/ppt. This was a complete paywall bypass, and it also let a
-- user rewrite email, org_id and created_at on their own row.
--
-- THE FIX
--
-- Postgres RLS cannot express "these columns only", but column-level GRANTs
-- can, and they are checked independently of RLS. Revoke blanket UPDATE and
-- re-grant only the two fields a user legitimately owns — the onboarding
-- profile fields, which is the sole reason the policy exists.
--
-- The backend is unaffected: it writes plan_tier through the service-role
-- client (routes/billing.ts, handlers/billing.ts), and service_role bypasses
-- both RLS and column grants. Verified before writing this that no frontend
-- code writes plan_tier — the only client-side users writes are the
-- onboarding name/DOB, which POST /account/profile already performs
-- server-side anyway.
revoke update on public.users from authenticated, anon;

-- full_name and date_of_birth are the only user-owned fields. Even these
-- are normally written by the backend (POST /account/profile); the grant
-- exists so the RLS policy remains meaningful rather than silently dead.
grant update (full_name, date_of_birth) on public.users to authenticated;

-- anon has no business updating this table at all. RLS already blocks it
-- (auth.uid() is null for anon, so USING never matches), but defence in
-- depth: a future policy change must not silently re-open this.
-- (The revoke above already covers anon; stated explicitly for the reader.)

comment on policy users_update_own on public.users is
  'Row scope only. Column scope is enforced by GRANTs (migration 0026): authenticated may update full_name and date_of_birth ONLY. plan_tier, org_id, email, id and created_at are service-role-only — granting UPDATE on plan_tier here was a complete paywall bypass.';
