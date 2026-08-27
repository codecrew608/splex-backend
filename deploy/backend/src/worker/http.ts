import type { HandlerResult } from "../handlers/result.js";

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export function errorResponse(message: string, status: number): Response {
  return jsonResponse({ message }, status);
}

export async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

// Worker half of the adapter pair — maps a runtime-agnostic HandlerResult
// onto a Response. routes/sendResult.ts maps the same shape onto a Fastify
// reply. Keeping both mappings this small is what lets the business logic in
// handlers/ stay completely transport-unaware.
//
// A 204 gets a null body because the Fetch API throws on constructing a
// Response with a body for a null-body status.
export function respondWithResult(result: HandlerResult): Response {
  if (!result.ok) {
    return errorResponse(result.message, result.status);
  }
  if (result.status === 204 || result.body === undefined) {
    return new Response(null, { status: result.status });
  }
  return jsonResponse(result.body, result.status);
}
