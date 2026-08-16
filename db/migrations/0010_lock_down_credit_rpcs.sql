-- CRITICAL SECURITY FIX. check_credits/consume_credits are SECURITY
-- DEFINER functions that take p_user_id as a raw, unchecked parameter --
-- neither function verifies the caller is actually that user. The
-- application code (credits/checkCredits.ts, credits/consumeCredits.ts)
-- already documented the assumption that "anon/authenticated keys are
-- revoked from executing it by design" -- but live-tested against the
-- actual deployed database just now and found that assumption false:
-- PUBLIC had EXECUTE on both, meaning any authenticated user could call
-- consume_credits() directly via the REST RPC endpoint with an arbitrary
-- p_user_id, arbitrarily inflating another user's usage_counters (denial
-- of service -- locks the victim out for the billing period) and
-- injecting fake credit_usage_logs rows attributed to them. Confirmed
-- exploitable end-to-end (a real authenticated session, not the service
-- role, successfully wrote to another account's counters) before this fix
-- was written. check_credits alone is a smaller information-disclosure
-- read, but gated the same way for consistency -- neither function should
-- ever be reachable except from the backend's own service-role client.
revoke execute on function public.check_credits(uuid, integer) from public, anon, authenticated;
revoke execute on function public.consume_credits(uuid, integer, text, complexity_level, text, numeric, integer, integer) from public, anon, authenticated;
grant execute on function public.check_credits(uuid, integer) to service_role;
grant execute on function public.consume_credits(uuid, integer, text, complexity_level, text, numeric, integer, integer) to service_role;
