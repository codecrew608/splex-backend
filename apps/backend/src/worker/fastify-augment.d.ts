// The Worker's tsconfig (tsconfig.worker.json) type-checks src/worker/**
// plus everything it transitively imports — which pulls in most of the
// existing service modules (they all still say `fastify: FastifyInstance`,
// unchanged, see worker/context.ts's doc comment for why that's fine at
// runtime). Those files rely on two ambient `declare module "fastify"`
// augmentations that are normally supplied by plugins/env.ts,
// plugins/supabaseAdmin.ts, and (via server.ts's value-import of
// fastify-sse-v2) that package's own bundled types — none of which the
// Worker's dependency graph ever imports, since it has no Fastify plugins
// or server.ts at all. This file re-supplies the same two augmentations
// (plus fastify-sse-v2's, needed only because sse/writer.ts's
// SplexSSEWriter class — unused by the Worker, but still type-checked
// since worker/sse.ts imports that file's SSEWriter type — references it)
// purely so `tsc -p tsconfig.worker.json` can see the same shape the main
// build already does. Erased entirely at build time — no runtime effect.
import "fastify-sse-v2";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkerConfig } from "./env.js";

declare module "fastify" {
  interface FastifyInstance {
    config: WorkerConfig;
    supabaseAdmin: SupabaseClient;
  }
}
