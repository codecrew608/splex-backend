// Port of plugins/cors.ts's @fastify/cors config (same allowed methods,
// same credentials:true, same FRONTEND_ORIGIN allowlist) — Workers has no
// CORS middleware built in, so preflight handling and response headers
// are both explicit here instead of a plugin registration.
const ALLOWED_METHODS = "GET,POST,DELETE,OPTIONS";
const ALLOWED_HEADERS = "Authorization,Content-Type";

export function resolveAllowedOrigin(requestOrigin: string | null, allowedOrigins: string[]): string | null {
  if (!requestOrigin) return null;
  return allowedOrigins.includes(requestOrigin) ? requestOrigin : null;
}

export function corsHeaders(requestOrigin: string | null, allowedOrigins: string[]): Record<string, string> {
  const origin = resolveAllowedOrigin(requestOrigin, allowedOrigins);
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}

export function handlePreflight(request: Request, allowedOrigins: string[]): Response {
  const origin = resolveAllowedOrigin(request.headers.get("origin"), allowedOrigins);
  return new Response(null, {
    status: 204,
    headers: {
      ...(origin
        ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", Vary: "Origin" }
        : {}),
      "Access-Control-Allow-Methods": ALLOWED_METHODS,
      "Access-Control-Allow-Headers": ALLOWED_HEADERS,
      "Access-Control-Max-Age": "86400",
    },
  });
}

// Applies CORS headers to any Response without rebuilding its body/status
// — used as the last step before returning from fetch() so every route
// (including error paths) gets consistent headers with one call site.
export function withCors(response: Response, requestOrigin: string | null, allowedOrigins: string[]): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(requestOrigin, allowedOrigins))) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
