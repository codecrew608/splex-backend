# Build from the MONOREPO ROOT, not this directory — the backend depends
# on the @splex/shared-types workspace package, so pnpm needs the whole
# workspace (root lockfile + packages/*) visible to resolve it correctly:
#
#   docker build -f apps/backend/Dockerfile -t splex-backend .
#
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared-types/package.json packages/shared-types/package.json
COPY apps/backend/package.json apps/backend/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared-types packages/shared-types
COPY apps/backend apps/backend
RUN pnpm --filter=@splex/backend build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /repo/node_modules /repo/node_modules
COPY --from=deps /repo/apps/backend/node_modules /repo/apps/backend/node_modules
COPY packages/shared-types packages/shared-types
COPY apps/backend/package.json apps/backend/package.json
COPY --from=build /repo/apps/backend/dist apps/backend/dist
WORKDIR /repo/apps/backend
EXPOSE 4000
CMD ["node", "dist/server.js"]
