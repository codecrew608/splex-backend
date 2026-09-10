import type { FastifyInstance } from "fastify";

// OpenRouter CREDENTIAL health (migration 0064) — an account-level
// observability signal, NOT a routing input. Answers "is the API 1
// credential currently rejected/disabled, and when did it last work?" —
// distinct from per-model capacity (openrouter/capacity.ts) and per-model
// reliability (cortex/modelHealth.ts), neither of which is keyed to the
// credential.
//
// Mirrors groq/health.ts exactly: fire-and-forget via the runtime's
// background scheduler when there is one (a bare floating promise is
// abandoned on Workers when the isolate is torn down), swallow own
// errors, never fail or slow a request whose real answer is already
// decided. Written only from cortex/modelHealth.ts — the single existing
// choke point for OpenRouter dispatch outcomes. Nothing reads this table
// to make a routing decision; it is a log/dashboard signal.

// The alias for the one credential Free and Starter route through today.
// "api2" (the Pro-reserved OPENROUTER_API_KEY_2 slot) is deliberately
// never written here while Pro is off — it has no dispatch path.
export const OPENROUTER_API_1_ALIAS = "api1";

function run(fastify: FastifyInstance, work: PromiseLike<{ error: { message: string } | null }>): void {
  const scheduled = Promise.resolve(work)
    .then(({ error }) => {
      if (error) fastify.log.warn({ error }, "record_openrouter_credential_outcome RPC failed (non-fatal)");
    })
    .catch((err: unknown) => fastify.log.warn({ err }, "openrouter credential-health write failed (non-fatal)"));
  if (fastify.scheduleBackground) {
    fastify.scheduleBackground(scheduled);
    return;
  }
  void scheduled;
}

export function recordOpenRouterCredentialSuccess(fastify: FastifyInstance): void {
  run(
    fastify,
    fastify.supabaseAdmin.rpc("record_openrouter_credential_outcome", {
      p_alias: OPENROUTER_API_1_ALIAS,
      p_success: true,
    }),
  );
}

// kind: "auth" for a rejected/disabled credential (also stamps
// last_auth_failure_at), anything else for an ordinary dispatch failure
// worth a last-failure timestamp.
export function recordOpenRouterCredentialFailure(fastify: FastifyInstance, status: number, kind: string): void {
  run(
    fastify,
    fastify.supabaseAdmin.rpc("record_openrouter_credential_outcome", {
      p_alias: OPENROUTER_API_1_ALIAS,
      p_success: false,
      p_status: status,
      p_kind: kind,
    }),
  );
}
