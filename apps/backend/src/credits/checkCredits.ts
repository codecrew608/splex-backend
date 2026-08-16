import type { FastifyInstance } from "fastify";

// Calls the service-role-only check_credits() Postgres function. Must be
// called with the service-role client — anon/authenticated keys are
// revoked from executing it by design (see db/migrations SQL).
export async function checkCredits(fastify: FastifyInstance, userId: string, creditCost: number): Promise<boolean> {
  const { data, error } = await fastify.supabaseAdmin.rpc("check_credits", {
    p_user_id: userId,
    p_credit_cost: creditCost,
  });

  if (error) {
    fastify.log.error({ error }, "check_credits RPC failed");
    return false;
  }

  return Boolean(data);
}
