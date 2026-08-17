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
    "@supabase/supabase-js": "^2.112.3",
    "dotenv": "^16.4.7",
    "fastify": "^5.12.0",
    "fastify-plugin": "^5.0.1",
    "fastify-sse-v2": "^4.2.2",
    "mammoth": "^1.12.1",
    "pdf-parse": "^2.4.5",
    "razorpay": "^2.9.8",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.10.1",
    "typescript": "^5.7.2"
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
# Optional -- payments stay disabled (503) until all four are set.
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
RAZORPAY_PRO_PLAN_ID=
INTELLIGENCE_SERVICE_URL=
LOG_LEVEL=info
EOF

# Regenerate the lockfile every time so it never silently falls out of
# sync with (or gets wiped by) a fresh bundle — package-lock-only skips
# actually installing node_modules, so this stays fast.
( cd "$OUT" && npm install --package-lock-only --silent )

echo "Bundle written to $OUT"
