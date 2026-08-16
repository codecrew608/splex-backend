import fp from "fastify-plugin";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { FastifyInstance } from "fastify";

declare module "fastify" {
  interface FastifyInstance {
    supabaseAdmin: SupabaseClient;
  }
}

// Service-role client. This is the ONLY Supabase client anywhere in the
// backend — it is what's allowed to read model_registry, messages.routed_model,
// and cortex_decisions, and to call check_credits()/consume_credits(). Never
// construct a second client with the anon key here; the backend has no use
// for one.
export default fp(async function supabaseAdminPlugin(fastify: FastifyInstance) {
  const client = createClient(fastify.config.SUPABASE_URL, fastify.config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  fastify.decorate("supabaseAdmin", client);
});
