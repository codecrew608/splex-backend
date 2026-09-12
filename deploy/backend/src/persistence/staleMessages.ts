import type { FastifyInstance } from "fastify";
import type { ScheduleBackground } from "../handlers/chat.js";

// Defence in depth for the "stuck in streaming forever" bug (real
// production incident, 2026-09-12): a plain-chat turn's whole request died
// abnormally mid-generation — most consistent with the Cloudflare Worker
// instance itself being killed, not a normal JS exception, since chat.ts's
// own bottom-of-function catch (written specifically to prevent exactly
// this) never ran. No in-process code can protect against the process
// itself being killed out from under it, so this is the out-of-band
// recovery layer instead: db/migrations/0066_*.sql's
// reap_stale_streaming_messages() RPC does the actual work (finalize the
// row, release the daily_requests reservation if this turn made one).
//
// Runs opportunistically on every plain-chat turn — same "safety net, not
// a requirement" posture as release_stale_media_reservations() (see
// DEPLOYMENT.md §8) — rather than on a schedule, since this stack has no
// scheduler. Fire-and-forget: never awaited, never allowed to affect or
// slow the request that triggered it. Mirrors groq/health.ts's and
// openrouter/health.ts's exact fire-and-forget shape.
export function reapStaleStreamingMessages(fastify: FastifyInstance, scheduleBackground: ScheduleBackground): void {
  const work = Promise.resolve(fastify.supabaseAdmin.rpc("reap_stale_streaming_messages"))
    .then(({ error }: { error: { message: string } | null }) => {
      if (error) fastify.log.warn({ error }, "reap_stale_streaming_messages RPC failed (non-fatal)");
    })
    .catch((err: unknown) => fastify.log.warn({ err }, "stale-message reap failed (non-fatal)"));
  scheduleBackground(work);
}
