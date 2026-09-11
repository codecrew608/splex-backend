-- 0065 — CRITICAL SECURITY FIX (regression of migration 0010's fix).
--
-- consume_credits (9-arg overload, added by migration 0055),
-- reserve_daily_request(uuid), and release_daily_request(uuid) are
-- SECURITY DEFINER functions with p_user_id as a raw, unchecked
-- caller-supplied parameter -- none of the three verifies the caller is
-- actually that user. All three currently have EXECUTE granted to anon
-- and authenticated (independently confirmed via Supabase's own security
-- advisor: anon_security_definer_function_executable /
-- authenticated_security_definer_function_executable, flagging these
-- exact three functions by exact signature).
--
-- Root cause: migration 0010 already fixed this exact class of bug once,
-- for check_credits and the then-only (8-arg) overload of
-- consume_credits. Migration 0055 added a 9th parameter to
-- consume_credits -- which creates a NEW function object in Postgres with
-- its own independent grants, not a signature change to the existing one
-- -- and introduced reserve_daily_request/release_daily_request as brand
-- new functions. Migration 0055 never repeated migration 0010's
-- revoke/grant pair for any of the three, so all three inherited
-- Postgres's default "EXECUTE granted to PUBLIC" behavior for newly
-- created functions.
--
-- Verified safe to revoke: every application call site for all three
-- functions (apps/backend/src/credits/consumeCredits.ts,
-- apps/backend/src/credits/checkCredits.ts) goes exclusively through
-- fastify.supabaseAdmin, the backend's one and only Supabase client,
-- constructed with SUPABASE_SERVICE_ROLE_KEY. No apps/web code calls any
-- of the three, or calls .rpc() on anything -- confirmed by exhaustive
-- source search, 2026-09-12.
--
-- The old 8-arg consume_credits overload (locked down by migration 0010)
-- is untouched here -- it was, and remains, correctly restricted to
-- service_role only.

revoke execute on function public.consume_credits(uuid, integer, text, complexity_level, text, numeric, integer, integer, boolean) from public, anon, authenticated;
revoke execute on function public.reserve_daily_request(uuid) from public, anon, authenticated;
revoke execute on function public.release_daily_request(uuid) from public, anon, authenticated;

grant execute on function public.consume_credits(uuid, integer, text, complexity_level, text, numeric, integer, integer, boolean) to service_role;
grant execute on function public.reserve_daily_request(uuid) to service_role;
grant execute on function public.release_daily_request(uuid) to service_role;
