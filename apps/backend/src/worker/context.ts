import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { FastifyInstance } from "fastify";
import { parseWorkerEnv, type RawWorkerEnv, type WorkerConfig } from "./env.js";

// Minimal logger matching the exact call shape used everywhere in this
// codebase — fastify.log.{info,warn,error,debug}(obj, msg) — via
// console.* (Workers ships every console.* call to `wrangler tail`/the
// dashboard's live log stream; there is no file/stdout to redirect on
// this runtime, so that's the correct sink here, not a stopgap).
export interface WorkerLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

function makeLogger(): WorkerLogger {
  const log = (level: "log" | "warn" | "error", obj: unknown, msg?: string) => {
    // eslint-disable-next-line no-console
    console[level](msg ?? "", obj);
  };
  return {
    info: (obj, msg) => log("log", obj, msg),
    warn: (obj, msg) => log("warn", obj, msg),
    error: (obj, msg) => log("error", obj, msg),
    debug: (obj, msg) => log("log", obj, msg),
  };
}

// This is the entire trick that lets every existing service module
// (cortex/*, credits/*, entitlements/*, research/*, persistence/*,
// images/audio/video/ppt, media/storage.ts, memory/*, intelligence/*)
// port to the Worker with ZERO code changes: every one of them takes a
// `fastify: FastifyInstance` first param and — verified directly by
// grepping every `fastify.*` member access outside routes/plugins/
// server.ts — only ever touches `.config`, `.supabaseAdmin`, and `.log`.
// A real Fastify instance is never constructed on Workers; this plain
// object satisfies the same structural shape those functions actually
// depend on, which is all TypeScript (and the functions themselves) ever
// checked for in the first place.
export interface WorkerCtx {
  config: WorkerConfig;
  supabaseAdmin: SupabaseClient;
  log: WorkerLogger;
}

export function buildWorkerCtx(env: RawWorkerEnv): WorkerCtx {
  const config = parseWorkerEnv(env);
  const supabaseAdmin = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return { config, supabaseAdmin, log: makeLogger() };
}

// Every existing service function is still typed `fastify: FastifyInstance`
// (unchanged — see this file's doc comment above for why that's safe to
// call with WorkerCtx at runtime). `FastifyInstance` itself has dozens of
// other required members (route methods, decorators, `.listen`, ...) that
// WorkerCtx deliberately doesn't implement, since none of them are ever
// touched by code running through this path — so TypeScript's structural
// check needs one explicit assist here. This is the ONLY cast in the
// entire Worker integration; everything downstream of it is fully typed.
export function asFastifyInstance(ctx: WorkerCtx): FastifyInstance {
  return ctx as unknown as FastifyInstance;
}
