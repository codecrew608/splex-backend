import { buildWorkerCtx, type WorkerCtx } from "./context.js";
import { WorkerConfigError, type RawWorkerEnv } from "./env.js";
import { authenticateWorker } from "./auth.js";
import { rateLimitByUser } from "./rateLimit.js";
import { RATE_LIMITS } from "../handlers/rateLimits.js";
import { corsHeaders, handlePreflight, withCors } from "./cors.js";
import { errorResponse, jsonResponse } from "./http.js";
import { handleHealth } from "./routes/health.js";
import { handleChatRequest, handleTruncateMessage } from "./routes/chat.js";
import { handleProcessFile } from "./routes/files.js";
import { handleCreateProject } from "./routes/projects.js";
import { handleFakeCheckout, handleFakeCancel } from "./routes/billing.js";
import { handleDeleteAccount, handleSaveProfile } from "./routes/account.js";
import { handleMediaStatus } from "./routes/media.js";
import { handleGetEntitlements } from "./routes/entitlements.js";
import type { AuthedUser } from "../types/index.js";
import { describeError } from "../openrouter/client.js";

// Same per-route limits as the Fastify original's fastify.rateLimitByUser
// calls (plugins/userRateLimit.ts) — see routes/chat.ts, files.ts,
// projects.ts, billing.ts, media.ts for the source of each number. The
// global per-IP flood baseline (plugins/rateLimit.ts, @fastify/rate-limit,
// 300/min) is deliberately NOT reimplemented here: it protected against a
// script hammering the backend before auth even runs, and Cloudflare's own
// edge network already does free, automatic L3/L4 DDoS mitigation in
// front of every Worker regardless of application code — a Postgres-
// backed re-implementation of the same IP-level check would add DB load
// for a concern the platform already covers. The per-USER limits below are
// the ones that actually protect credits/entitlements, and every one of
// them is preserved.
// Rate limits now come from handlers/rateLimits.ts, shared with the
// Fastify stack — previously this table and the *_RATE_LIMIT consts in
// routes/*.ts were two independent copies of the same security-relevant
// numbers.

async function requireAuth(request: Request, ctx: WorkerCtx): Promise<AuthedUser | Response> {
  const result = await authenticateWorker(request, ctx);
  if (!result.ok) return errorResponse(result.message, result.status);
  return result.user;
}

async function requireRateLimit(
  ctx: WorkerCtx,
  routeName: keyof typeof RATE_LIMITS,
  userId: string,
): Promise<Response | null> {
  const { max, windowMs } = RATE_LIMITS[routeName];
  const allowed = await rateLimitByUser(ctx, routeName, userId, max, windowMs);
  if (!allowed) return errorResponse("You're doing that too fast — please slow down and try again shortly.", 429);
  return null;
}

// Deliberately a plain if-chain over method+pathname, not a routing
// library — ~10 routes total, and every one of this codebase's actual
// route files (routes/*.ts) already reads as one handler per
// method+path, so this mirrors that shape directly rather than adding a
// new abstraction for a problem this small.
async function route(request: Request, ctx: WorkerCtx, execCtx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (method === "GET" && pathname === "/health") {
    return handleHealth();
  }

  if (method === "POST" && pathname === "/chat") {
    const auth = await requireAuth(request, ctx);
    if (auth instanceof Response) return auth;
    const limited = await requireRateLimit(ctx, "chat", auth.id);
    if (limited) return limited;
    return handleChatRequest(request, ctx, auth, execCtx);
  }

  const truncateMatch = pathname.match(/^\/chat\/messages\/([^/]+)\/truncate$/);
  if (method === "DELETE" && truncateMatch) {
    const auth = await requireAuth(request, ctx);
    if (auth instanceof Response) return auth;
    const limited = await requireRateLimit(ctx, "chat_truncate", auth.id);
    if (limited) return limited;
    return handleTruncateMessage(truncateMatch[1], request, ctx, auth);
  }

  const fileProcessMatch = pathname.match(/^\/files\/([^/]+)\/process$/);
  if (method === "POST" && fileProcessMatch) {
    const auth = await requireAuth(request, ctx);
    if (auth instanceof Response) return auth;
    const limited = await requireRateLimit(ctx, "files_process", auth.id);
    if (limited) return limited;
    return handleProcessFile(fileProcessMatch[1], ctx, auth);
  }

  if (method === "POST" && pathname === "/projects") {
    const auth = await requireAuth(request, ctx);
    if (auth instanceof Response) return auth;
    const limited = await requireRateLimit(ctx, "projects_create", auth.id);
    if (limited) return limited;
    return handleCreateProject(request, ctx, auth);
  }

  if (method === "POST" && pathname === "/billing/fake-checkout") {
    const auth = await requireAuth(request, ctx);
    if (auth instanceof Response) return auth;
    const limited = await requireRateLimit(ctx, "billing_checkout", auth.id);
    if (limited) return limited;
    return handleFakeCheckout(ctx, auth);
  }

  if (method === "POST" && pathname === "/billing/fake-cancel") {
    const auth = await requireAuth(request, ctx);
    if (auth instanceof Response) return auth;
    const limited = await requireRateLimit(ctx, "billing_cancel", auth.id);
    if (limited) return limited;
    return handleFakeCancel(ctx, auth);
  }

  if (method === "DELETE" && pathname === "/account") {
    const auth = await requireAuth(request, ctx);
    if (auth instanceof Response) return auth;
    return handleDeleteAccount(ctx, auth);
  }

  if (method === "POST" && pathname === "/account/profile") {
    const auth = await requireAuth(request, ctx);
    if (auth instanceof Response) return auth;
    const limited = await requireRateLimit(ctx, "account_profile", auth.id);
    if (limited) return limited;
    return handleSaveProfile(request, ctx, auth);
  }

  const mediaStatusMatch = pathname.match(/^\/media\/([^/]+)\/status$/);
  if (method === "GET" && mediaStatusMatch) {
    const auth = await requireAuth(request, ctx);
    if (auth instanceof Response) return auth;
    const limited = await requireRateLimit(ctx, "media_status", auth.id);
    if (limited) return limited;
    return handleMediaStatus(mediaStatusMatch[1], ctx, auth);
  }

  if (method === "GET" && pathname === "/entitlements") {
    const auth = await requireAuth(request, ctx);
    if (auth instanceof Response) return auth;
    return handleGetEntitlements(ctx, auth);
  }

  return errorResponse("Not found.", 404);
}

export default {
  async fetch(request: Request, env: RawWorkerEnv, execCtx: ExecutionContext): Promise<Response> {
    let ctx: WorkerCtx;
    try {
      ctx = buildWorkerCtx(env);
    } catch (err) {
      if (err instanceof WorkerConfigError) {
        // eslint-disable-next-line no-console
        console.error(err.message);
        return jsonResponse({ message: "Server misconfigured." }, 500);
      }
      throw err;
    }

    if (request.method === "OPTIONS") {
      return handlePreflight(request, ctx.config.FRONTEND_ORIGIN);
    }

    try {
      const response = await route(request, ctx, execCtx);
      return withCors(response, request.headers.get("origin"), ctx.config.FRONTEND_ORIGIN);
    } catch (err) {
      // Same backstop role as server.ts's global setErrorHandler — never
      // leak a raw thrown error's message to the client.
      // describeError, not a raw Error: an Error's fields are non-enumerable,
      // so `{ err }` serialises to "{}" in Cloudflare's log capture — the exact
      // blindness that made the production model failures undiagnosable.
      // Logs the PATH only, never the full URL, so query strings can never
      // carry user data into logs.
      ctx.log.error(
        { ...describeError(err), path: new URL(request.url).pathname },
        "unhandled error reached Worker fetch() handler",
      );
      return withCors(
        jsonResponse({ message: "Something went wrong. Please try again." }, 500),
        request.headers.get("origin"),
        ctx.config.FRONTEND_ORIGIN,
      );
    }
  },
};

// Re-exported for anything that wants CORS headers without going through
// the full route() dispatch (none currently — kept for parity/clarity
// with plugins/cors.ts being a separately-registered plugin).
export { corsHeaders };
