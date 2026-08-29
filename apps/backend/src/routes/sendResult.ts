import type { FastifyReply } from "fastify";
import type { HandlerResult } from "../handlers/result.js";

// Fastify half of the adapter pair — maps a runtime-agnostic HandlerResult
// onto a Fastify reply. The Worker's equivalent is worker/http.ts's
// respondWithResult(), which maps the same shape onto a Response.
//
// 204 is special-cased because Fastify (correctly) refuses to serialize a
// body for a no-content status, and every prior copy of these routes ended
// with a bare `reply.code(204).send()`.
export function sendResult(reply: FastifyReply, result: HandlerResult): FastifyReply {
  if (!result.ok) {
    return reply.code(result.status).send({ message: result.message });
  }
  if (result.status === 204 || result.body === undefined) {
    return reply.code(result.status).send();
  }
  return reply.code(result.status).send(result.body);
}
