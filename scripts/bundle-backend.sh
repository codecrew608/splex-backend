#!/usr/bin/env bash
# Generates deploy/backend/ — a fully standalone copy of apps/backend with
# zero monorepo dependency: no pnpm workspace, no `extends`, no
# @splex/shared-types package reference. Point any Docker-based host at
# this folder directly and it builds with no knowledge of the rest of the
# repo. This is a generated artifact (like dist/) — apps/backend/src stays
# the single source of truth. Re-run this script after backend changes to
# refresh the bundle before redeploying.
set -euo pipefail
cd "$(dirname "$0")/.."

# Lockfile generation is PINNED to a specific npm.
#
# package-lock.json content is npm-version-dependent: npm 11 writes a
# "libc": ["glibc"|"musl"] field on platform-specific native packages that
# npm 10 does not understand and strips back out. Regenerating with a
# different npm than the one that last wrote the file therefore produces a
# spurious 200-line diff — which is exactly what failed CI's deploy/ parity
# gate, on a bundle whose SOURCE was byte-identical.
#
# Pinning here (rather than assuming the caller's Node) is what makes the
# scripts genuinely deterministic: the output is the same on a maintainer's
# machine, on a fresh CI runner, and in the Docker build, whatever Node
# happens to be on PATH.
#
# 10.x is the correct target, not the newest: deploy/backend/Dockerfile
# builds on node:22-slim, the root package.json requires node >=22, and CI
# pins node 22 — all of which ship npm 10. The lockfile should describe what
# those environments will actually install.
NPM_PIN="npm@10.9.8"

OUT=deploy/backend
rm -rf "$OUT"
mkdir -p "$OUT/src"

cp -r apps/backend/src/. "$OUT/src/"
cp packages/shared-types/src/index.ts "$OUT/src/shared-types.ts"

# Rewrite every "@splex/shared-types" import to a relative path pointing at
# the inlined src/shared-types.ts, with the correct number of "../" for
# that file's depth under src/.
find "$OUT/src" -name '*.ts' ! -name 'shared-types.ts' | while read -r file; do
  rel="${file#"$OUT"/src/}"
  depth=$(dirname "$rel" | awk -F/ '{ n = ($0 == ".") ? 0 : NF; print n }')
  prefix=""
  for ((i = 0; i < depth; i++)); do prefix="../$prefix"; done
  sed -i -E "s#[\"']@splex/shared-types[\"']#\"${prefix}shared-types.js\"#g" "$file"
done

cat > "$OUT/package.json" <<'EOF'
{
  "name": "splex-backend",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "typecheck:worker": "tsc --noEmit -p tsconfig.worker.json",
    "cf:dev": "wrangler dev",
    "cf:deploy": "wrangler deploy"
  },
  "dependencies": {
    "@fastify/cors": "^11.3.0",
    "@fastify/rate-limit": "^11.2.0",
    "@supabase/supabase-js": "^2.112.3",
    "dotenv": "^16.4.7",
    "fastify": "^5.12.0",
    "fastify-plugin": "^5.0.1",
    "fastify-sse-v2": "^4.2.2",
    "mammoth": "^1.12.1",
    "pdf-parse": "^2.4.5",
    "pptxgenjs": "^4.0.1",
    "unpdf": "^1.8.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@cloudflare/containers": "^0.3.7",
    "@cloudflare/workers-types": "^5.20260821.1",
    "@types/node": "^22.10.1",
    "typescript": "^5.7.2",
    "wrangler": "^4.125.0"
  }
}
EOF

cat > "$OUT/tsconfig.json" <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src"],
  "exclude": ["src/worker"]
}
EOF

cat > "$OUT/tsconfig.worker.json" <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["@cloudflare/workers-types"]
  },
  "include": ["src/worker"]
}
EOF

cat > "$OUT/Dockerfile" <<'EOF'
# Fully self-contained — build from WITHIN this folder, no parent context
# needed: docker build -t splex-backend .
FROM node:22-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 4000
CMD ["node", "dist/server.js"]
EOF

cat > "$OUT/.dockerignore" <<'EOF'
node_modules
dist
.env
.env.local
*.log
EOF

cat > "$OUT/.env.example" <<'EOF'
PORT=4000
FRONTEND_ORIGIN=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_SITE_URL=
OPENROUTER_APP_NAME=SPLEX
CORTEX_CLASSIFIER_MODEL_ID=
CREDITS_PER_USD=25000
INTELLIGENCE_SERVICE_URL=
LOG_LEVEL=info
EOF

# Cloudflare Workers FREE deployment target (src/worker/) — a real
# fetch(request, env, ctx) entrypoint, no Containers, no Durable Objects,
# no paid plan required. This is the CURRENT deployment target; the
# cloudflare/ Containers config emitted below this block is an earlier,
# now-superseded option (kept, not deleted, per this project's "never
# silently drop existing work" convention — see the migration report for
# which one to actually use).
cat > "$OUT/wrangler.jsonc" <<'EOF'
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "splex-backend-worker",
  "main": "src/worker/index.ts",
  "compatibility_date": "2026-08-21",
  // Required for Buffer (mammoth/pdf-parse/pptxgenjs/media Buffer
  // handling) and node:crypto-shaped globals — everything else in
  // src/worker/ uses only Web-standard APIs (fetch, Request, Response,
  // ReadableStream, crypto.randomUUID()).
  "compatibility_flags": ["nodejs_compat"],
  // No [[containers]], no durable_objects, no paid-plan-only bindings —
  // deliberately: this config must deploy on Workers Free as-is.
  "observability": {
    "enabled": true
  },
  // Non-secret production config for worker/env.ts's schema. Every field
  // here is required-with-no-default or has a default that's wrong for
  // production (see that file) — omitting any of them is exactly what
  // produced the live "500 Server misconfigured" (buildWorkerCtx() throws
  // WorkerConfigError, worker/index.ts's fetch() handler catches it and
  // returns 500 before any route ever runs). SUPABASE_SERVICE_ROLE_KEY and
  // OPENROUTER_API_KEY are NOT here — those stay `wrangler secret put`
  // only, never a plaintext var, never committed. PORT is intentionally
  // absent — meaningless on Workers (no TCP listen), and worker/env.ts's
  // schema never requires it. INTELLIGENCE_SERVICE_URL is intentionally
  // absent too: it's optional in worker/env.ts specifically because
  // Workers can't reach a local/loopback address in production, and every
  // call site already treats "unset" as "skip OCR/embedding, degrade
  // gracefully" — setting it to localhost here would be actively wrong,
  // not just incomplete.
  "vars": {
    "FRONTEND_ORIGIN": "https://splex-ai.vercel.app",
    "SUPABASE_URL": "https://yxhallicacslnwwmxnhd.supabase.co",
    "OPENROUTER_BASE_URL": "https://openrouter.ai/api/v1",
    "OPENROUTER_SITE_URL": "https://splex-ai.vercel.app",
    "OPENROUTER_APP_NAME": "SPLEX",
    "CORTEX_CLASSIFIER_MODEL_ID": "qwen/qwen-2.5-72b-instruct",
    "CREDITS_PER_USD": "20000",
    "LOG_LEVEL": "info"
  }
}
EOF

cat > "$OUT/.dev.vars.example" <<'EOF'
FRONTEND_ORIGIN=http://localhost:3000
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_SITE_URL=http://localhost:3000
OPENROUTER_APP_NAME=SPLEX
CORTEX_CLASSIFIER_MODEL_ID=
CREDITS_PER_USD=20000
INTELLIGENCE_SERVICE_URL=
LOG_LEVEL=info
EOF

# --- Superseded option below: Cloudflare Containers (kept, not deleted) ---
# Requires Workers Paid + Containers — do not use for the Free-tier goal.
mkdir -p "$OUT/cloudflare"

cat > "$OUT/cloudflare/wrangler.jsonc" <<'EOF'
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "splex-backend",
  "main": "container-entry.ts",
  "compatibility_date": "2026-08-21",
  "compatibility_flags": ["nodejs_compat"],
  // Builds the image from the Dockerfile one level up (this project's
  // deploy/backend root) — the exact same Dockerfile already build-tested
  // locally, never a second/parallel Dockerfile to keep in sync.
  "containers": [
    {
      "class_name": "SplexBackendContainer",
      "image": "../Dockerfile",
      "max_instances": 5,
      // Non-secret only — SUPABASE_SERVICE_ROLE_KEY and OPENROUTER_API_KEY
      // are set via `wrangler secret put` (see DEPLOYMENT.md), never here.
      "env": {
        "PORT": "4000",
        "OPENROUTER_BASE_URL": "https://openrouter.ai/api/v1",
        "OPENROUTER_APP_NAME": "SPLEX",
        "CREDITS_PER_USD": "25000",
        "LOG_LEVEL": "info"
      }
    }
  ],
  "durable_objects": {
    "bindings": [
      { "name": "SPLEX_BACKEND", "class_name": "SplexBackendContainer" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["SplexBackendContainer"] }
  ],
  "observability": {
    "enabled": true
  }
}
EOF

cat > "$OUT/cloudflare/container-entry.ts" <<'EOF'
import { Container, getContainer } from "@cloudflare/containers";

// Fronts the Dockerized Fastify server (this folder's Dockerfile, built
// unchanged) behind a Durable Object. Deliberately does nothing else —
// no auth, no routing logic, no request rewriting — Fastify's own CORS,
// auth, and rate-limit plugins run exactly as they do today, inside the
// container. container.fetch() proxies the request/response verbatim,
// including chunked/streamed bodies, which is what SSE (fastify-sse-v2)
// needs to keep working unmodified.
export class SplexBackendContainer extends Container {
  defaultPort = 4000;
  // SSE connections (chat streaming, Deep Research) are long-lived —
  // don't let Cloudflare recycle the instance mid-stream on ordinary
  // idle-timeout defaults.
  sleepAfter = "10m";
}

interface Env {
  SPLEX_BACKEND: DurableObjectNamespace<SplexBackendContainer>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const container = getContainer(env.SPLEX_BACKEND);
    return container.fetch(request);
  },
};
EOF

# Install for real (not --package-lock-only) — this regenerates the
# lockfile AND populates node_modules, and both are required.
#
# The lockfile alone was not enough. `wrangler deploy` bundles src/worker
# with esbuild, which resolves every bare import off the DISK at bundle
# time; there is no separate install step in that path the way there is
# for Docker (whose Dockerfile runs its own `npm install` inside the
# image). With a lockfile but no node_modules, Wrangler failed with
# "Could not resolve" for pptxgenjs, @supabase/supabase-js, zod, mammoth
# and unpdf — the packages src/worker actually reaches. Nothing upstream
# could rescue it either: pnpm's default isolated layout means the repo
# root's node_modules holds only .pnpm internals with no top-level package
# directories, so Node's walk-up resolution from deploy/backend finds
# nothing.
#
# This must live in the script rather than being a manual pre-deploy step,
# because `rm -rf "$OUT"` at the top of this file deletes node_modules on
# every regeneration — so any install done by hand is destroyed the next
# time anyone refreshes the bundle, silently re-breaking the Worker deploy.
#
# Dependencies resolve from the bundle's OWN package.json, never the
# workspace, which is what keeps this folder genuinely standalone.
# devDependencies are installed too, deliberately: wrangler.jsonc's
# "$schema" points at node_modules/wrangler/config-schema.json, and having
# wrangler local pins the CLI version instead of letting `npx` fetch an
# arbitrary one. deploy/backend/node_modules is gitignored (.gitignore's
# "node_modules/" matches at any depth), so this never enters the repo.
( cd "$OUT" && npx --yes "$NPM_PIN" install --silent )

echo "Bundle written to $OUT"
