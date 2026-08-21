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
    "start": "node dist/server.js"
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
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@cloudflare/containers": "^0.3.7",
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
  "include": ["src"]
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

# Cloudflare Containers plumbing — kept entirely outside src/ (a separate
# Workers-runtime entrypoint, not compiled by tsc/tsconfig.json above,
# which targets Node for the actual Fastify dist/server.js image). This
# Worker is a thin router only: it never touches Fastify, SSE, or
# OpenRouter logic — those stay exactly as they are inside the container
# image built from this same folder's Dockerfile.
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

# Regenerate the lockfile every time so it never silently falls out of
# sync with (or gets wiped by) a fresh bundle — package-lock-only skips
# actually installing node_modules, so this stays fast.
( cd "$OUT" && npm install --package-lock-only --silent )

echo "Bundle written to $OUT"
