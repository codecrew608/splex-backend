// The contract between runtime-agnostic business logic (handlers/) and the
// two HTTP adapters that expose it (Fastify routes/, Cloudflare
// worker/routes/).
//
// A handler decides WHAT happened and what the user should be told; the
// adapter decides HOW to say it over its own transport — reply.code().send()
// for Fastify, a Response object for Workers. That split is the whole point:
// business logic that had to be written twice (and therefore fixed twice,
// four separate times in one session before this existed) now lives once,
// while each runtime keeps the HTTP layer it actually needs.
//
// Deliberately carries an explicit `status` rather than letting adapters
// invent one: the status code is part of the API contract the frontend reads
// (it distinguishes 403 quota-exceeded from 500 server-error), so it belongs
// with the decision, not the transport.
export type HandlerResult<T = unknown> =
  | { ok: true; status: number; body?: T }
  | { ok: false; status: number; message: string };

export function ok<T>(body?: T, status = 200): HandlerResult<T> {
  return { ok: true, status, body };
}

export function noContent(): HandlerResult<never> {
  return { ok: true, status: 204 };
}

export function fail(message: string, status = 500): HandlerResult<never> {
  return { ok: false, status, message };
}
