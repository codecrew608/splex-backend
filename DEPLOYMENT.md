# SPLEX Production Deployment Guide

Three independently-deployable units — this document covers what each
needs, plus the wiring between all three. **Nothing in this repo has been
deployed anywhere as part of preparing this document.** Dockerfiles were
build-tested locally only (`docker build`, never `run`/`push`), and the
Cloudflare configuration below (added in the Cloudflare-prep phase) has
been build/typecheck-verified locally only — no `wrangler deploy` or
`wrangler publish` has been run against a real Cloudflare account.

## The three units

| Unit | What it is | Prepared Cloudflare target | Also runs on |
|---|---|---|---|
| `apps/web` (bundled as `deploy/frontend`) | Next.js 15 frontend | Cloudflare Pages/Workers, via `@opennextjs/cloudflare` | Vercel |
| `apps/backend` (bundled as `deploy/backend`) | Fastify API + SSE streaming + Cortex orchestration | Cloudflare Containers (Worker + Durable Object fronting the existing Dockerfile) | Any host that runs a long-lived Node process (Railway, Render, Fly.io, a VPS, ECS/Fargate) |
| `services/intelligence` | Python/FastAPI sidecar — Tesseract OCR + BGE embeddings | Cloudflare Containers, **private only** (no public route) | Any Docker-capable host (needed for the `tesseract-ocr` apt package — no Python-only buildpack will work) |

**Railway/current deployment stays live and untouched** — this section
documents a prepared, not-yet-activated Cloudflare setup, added alongside
the existing options above, not a replacement of them yet.

The database (Supabase Postgres + Auth + Storage) is already fully
provisioned and migrated — see "Database" below, nothing to do there at
deploy time unless you're deliberately standing up a separate prod project.

A `Dockerfile` now exists for both `apps/backend` and
`services/intelligence` (there wasn't one before). Both were build-tested
locally today with real `docker build` runs (confirmed via `docker images`,
not just exit codes — one masked a real failure earlier) and now complete
successfully end-to-end. Three real, non-obvious issues surfaced and were
fixed in the process — see "Dockerfile notes" below.

---

## Backend (`apps/backend`) — environment variables

| Variable | Secret? | Value |
|---|---|---|
| `PORT` | no | Most platforms inject this themselves — check your platform's docs before hardcoding it |
| `FRONTEND_ORIGIN` | no | Your real Vercel production URL, exactly (used for CORS — see "Wiring checklist") |
| `SUPABASE_URL` | no | `https://yxhallicacslnwwmxnhd.supabase.co` (same project already in use) |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes** | Full database bypass privileges — copy from local `.env`. Never exposed to the frontend. |
| `OPENROUTER_API_KEY` | **yes** | Copy from local `.env` |
| `OPENROUTER_BASE_URL` | no | `https://openrouter.ai/api/v1` |
| `OPENROUTER_SITE_URL` | no | Set to your real prod frontend URL — OpenRouter uses this for their own attribution, currently set to `localhost` locally |
| `OPENROUTER_APP_NAME` | no | `SPLEX` |
| `CORTEX_CLASSIFIER_MODEL_ID` | no | Copy from local `.env` |
| `CREDITS_PER_USD` | no | `20000` (business-tunable, not a secret — 1 SPLEX Credit = $0.00005 normalized cost per the V1 pricing spec) |
| `INTELLIGENCE_SERVICE_URL` | no | The intelligence service's **deployed** URL, not `127.0.0.1` — ideally a private/internal network address, not a public one (see "Intelligence service" below) |
| `LOG_LEVEL` | no | `info` |

**Backend health check:** `GET /health` → `{"status":"ok"}`.

**Billing is a fake gateway, not real payments.** There is no Razorpay (or
any other) integration — `/billing/fake-checkout` and `/billing/fake-cancel`
flip `plan_tier` between `free`/`pro` directly and synchronously, no
external gateway, no webhook, no payment env vars required. See "What
changed" below.

## Intelligence service (`services/intelligence`) — environment variables

| Variable | Secret? | Value |
|---|---|---|
| `PORT` | no | Platform-injected, or defaults to `8100` |
| `HOST` | no | **Must be set to `0.0.0.0` in production.** Defaults to `127.0.0.1` (loopback-only), which was fine when the backend calls it on the same machine in local dev, but is unreachable from anywhere else — this was a real gap fixed today (`main.py`, `run.sh`) precisely because it would otherwise silently fail to be reachable once deployed. |

No Supabase/OpenRouter credentials needed here — it's a stateless
OCR/embedding sidecar, called only by the backend.

**This service has no authentication on its endpoints** (`/embed`,
`/ocr/image`, `/ocr/pdf`). Deploy it on a **private network reachable only
by the backend**, not with a public URL — most platforms with multi-service
support (Railway, Render, Fly.io internal networking, AWS VPC) offer this
directly. If your platform can't do private networking between services,
add a shared-secret header check before exposing it publicly — that's not
built today because it's unnecessary complexity if private networking is
available, but don't skip one or the other.

**Health check:** `GET /health` → `{"status":"ok"}`.

## Frontend (Vercel) — environment variables, for your reference

You're handling this deploy, but for completeness, here's everything
`apps/web` reads from `process.env`:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://yxhallicacslnwwmxnhd.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Copy from local `.env.local` |
| `NEXT_PUBLIC_BACKEND_URL` | The backend's **public** deployed URL (not the intelligence service — the frontend never talks to that directly) |

---

## Cloudflare deployment (prepared, not yet activated)

Config only — nothing below has been deployed. Three Cloudflare projects,
one per unit, using the exact same source each unit already builds from
(`deploy/frontend`, `deploy/backend`, `services/intelligence`). Regenerate
`deploy/` first if `apps/` changed: `./scripts/bundle-backend.sh && ./scripts/bundle-frontend.sh`
— both scripts now also emit the Cloudflare config described here, so a
re-bundle never drops it.

### Frontend — Cloudflare Pages (via Workers + static assets)

- Files: `apps/web/wrangler.jsonc`, `apps/web/open-next.config.ts` (source
  of truth; carried into `deploy/frontend` automatically by
  `bundle-frontend.sh`'s existing copy step — no separate Cloudflare files
  needed there).
- Adapter: `@opennextjs/cloudflare` (current Cloudflare-recommended path for
  Next.js 15 App Router — supersedes the older `@cloudflare/next-on-pages`,
  which handles this repo's `middleware.ts` pattern less reliably).
- **Dashboard steps:**
  1. Cloudflare dashboard → Workers & Pages → Create → connect the GitHub
     repo (`codecrew608/splex-backend`).
  2. Root directory: `deploy/frontend`.
  3. Build command: `npm install && npm run cf:build` (runs
     `opennextjs-cloudflare build`, producing `.open-next/`).
  4. Deploy command / output: `npx wrangler deploy` picks up
     `wrangler.jsonc` in that same root directory automatically.
  5. Set environment variables and secrets (below) in the project's
     Settings → Variables, for the Production environment.
  6. Attach the custom domain once DNS is ready (Settings → Domains &
     Routes).
- **What was verified not to break:** App Router structure, `middleware.ts`
  (Supabase session-refresh — needs the `nodejs_compat` compatibility flag,
  already set in `wrangler.jsonc`), and the one API route
  (`app/(auth)/auth/callback/route.ts`) — none of these were modified; the
  adapter wraps the existing Next.js build output, it doesn't require
  rewriting App Router code.

### Backend — Cloudflare Containers

- Files: `deploy/backend/cloudflare/wrangler.jsonc`,
  `deploy/backend/cloudflare/container-entry.ts` (generated by
  `bundle-backend.sh`, same as the rest of `deploy/backend`'s meta files).
- Architecture: a Worker + Durable Object (`SplexBackendContainer`) fronts
  the **existing, unmodified** `deploy/backend/Dockerfile` image. The
  Worker's only job is `container.fetch(request)` — a verbatim proxy,
  including streamed/chunked bodies, so SSE (`fastify-sse-v2`, used for
  chat and Deep Research streaming) keeps working unchanged. Fastify's own
  CORS, auth, and rate-limit plugins are untouched and still run inside the
  container exactly as before.
- **Dashboard steps:**
  1. Workers & Pages → Create → connect the same GitHub repo.
  2. Root directory: `deploy/backend/cloudflare`.
  3. This deploys `wrangler.jsonc`'s `[[containers]]` block, which builds
     the image from `../Dockerfile` (i.e. `deploy/backend/Dockerfile`,
     unchanged) — no separate container registry push needed, Cloudflare
     builds it from the Dockerfile directly.
  4. Set the two secrets (below) via `wrangler secret put` or the
     dashboard's Settings → Variables → "Encrypt" toggle — never as plain
     `env` values in `wrangler.jsonc` (that file only carries non-secret
     values, matching the existing `.env.example` convention).
  5. Attach the API subdomain (e.g. `api.<domain>`) under Domains & Routes.

### Intelligence service — Cloudflare Containers, private only

- Files: `services/intelligence/cloudflare/wrangler.jsonc`,
  `services/intelligence/cloudflare/container-entry.ts` (new — this service
  isn't part of the `deploy/` bundle system, so these live directly beside
  its existing `Dockerfile`/`main.py`, hand-maintained like the rest of
  that service).
- **This must stay unreachable from the public internet** — same
  requirement as every other platform option in this doc, since `/embed`
  and `/ocr/*` still have no request auth. Enforced here via
  `workers_dev: false` and no `routes`/custom domain in
  `wrangler.jsonc` — do not add either without also adding a shared-secret
  header check to `main.py` first.
  - The backend container reaches it the same way it does today: via
    `INTELLIGENCE_SERVICE_URL` pointed at Cloudflare's private
    container-to-container network address, **not** a `workers.dev` URL.
- **Dashboard steps:**
  1. Workers & Pages → Create → connect the repo.
  2. Root directory: `services/intelligence/cloudflare`.
  3. Confirm no domain/route is attached after deploy (the dashboard shows
     this under the project's Domains & Routes tab — it should be empty).

### Environment variables and secrets — Cloudflare specifically

| Where | Var | Secret? | Notes |
|---|---|---|---|
| Frontend Worker | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_BACKEND_URL` | no | Same three as the Vercel table above — set as Cloudflare Pages "Environment variables," not secrets (they're safe-to-expose by design, verified this session) |
| Backend Container | `FRONTEND_ORIGIN`, `SUPABASE_URL`, `OPENROUTER_SITE_URL`, `CORTEX_CLASSIFIER_MODEL_ID`, `INTELLIGENCE_SERVICE_URL` | no | Set in `[[containers]].env` in `wrangler.jsonc` or dashboard Variables (`PORT`, `OPENROUTER_BASE_URL`, `OPENROUTER_APP_NAME`, `CREDITS_PER_USD`, `LOG_LEVEL` are already pre-filled there with their known non-secret values) |
| Backend Container | `SUPABASE_SERVICE_ROLE_KEY`, `OPENROUTER_API_KEY` | **yes** | `wrangler secret put SUPABASE_SERVICE_ROLE_KEY` / `wrangler secret put OPENROUTER_API_KEY` from inside `deploy/backend/cloudflare` — never committed, never in `wrangler.jsonc` |
| Intelligence Container | `HOST`, `PORT` | no | Already pre-filled in `wrangler.jsonc`'s `[[containers]].env` |

### Deployment order (once you activate this — still not done)

1. Intelligence service first (backend depends on its URL at boot/first call).
2. Backend second, once `INTELLIGENCE_SERVICE_URL` can point at the
   intelligence Container's real private address.
3. Frontend last, once `NEXT_PUBLIC_BACKEND_URL` can point at the backend's
   real public URL, and the backend's `FRONTEND_ORIGIN` has been set to the
   frontend's real URL (circular — expect one redeploy of whichever went
   first, to fill in the other's now-known URL; same wiring caveat as the
   existing Vercel/Railway checklist below).
4. Re-run this doc's existing local verification (build/typecheck) plus a
   live smoke test through the real Cloudflare URLs before pointing DNS at
   any of them for real traffic.

---

## Wiring checklist (the part that's easy to get subtly wrong)

- [ ] Backend's `FRONTEND_ORIGIN` = the exact Vercel production URL (protocol + host, no trailing slash) — a mismatch here means every request fails CORS, not a partial failure
- [ ] Frontend's `NEXT_PUBLIC_BACKEND_URL` = the backend's real public URL
- [ ] Backend's `INTELLIGENCE_SERVICE_URL` = the intelligence service's real deployed URL (private network address, per above)

## Billing — fake gateway, nothing to configure

There is no real payment gateway integration. `POST /billing/fake-checkout`
and `POST /billing/fake-cancel` (both authenticated) flip the caller's own
`plan_tier` between `free` and `pro` directly, synchronously, no external
call involved — see `apps/backend/src/routes/billing.ts`. No env vars, no
webhook, no dashboard setup. The frontend's upgrade flow
(`FakeCheckoutModal`) is deliberately, visibly labeled "Test mode" so
there's no chance of it reading as a real charge.

If real payments are wired up later, that integration would replace these
two routes and reintroduce webhook-driven `plan_tier` updates — worth
keeping in mind that `/billing/fake-checkout` succeeding unconditionally
is fine only as long as nothing behind it is real money.

## Database

Already fully migrated — all migrations in `db/migrations/` through
`0017_web_search_free_tier_fallback.sql` (17 total; image/audio/video/ppt
generation, cost-aware model routing + health tracking, Agent Workflows,
and web search/deep research were all added after the pricing rebuild
below, each in its own numbered migration) are applied to the Supabase
project this app already talks to (`yxhallicacslnwwmxnhd`), including the
Free/Pro limits and the file-upload/storage enforcement trigger. The
`uploads` Storage bucket already exists (private, confirmed live). If this
is meant to stay the one production database, there is nothing left to do
here.

If instead you want a **separate** production Supabase project (isolated
from whatever this one has accumulated during development), every
migration needs to be replayed there in order — most of them insert seed
data, not just schema (`model_registry` rows, `plan_limits`,
`credit_cost_bands`, and more), so a schema-only copy isn't sufficient.
Re-verify the count against `ls db/migrations/` before relying on this
document's number — it will go stale again the next time one is added.

**Outstanding from earlier in this project:** the database password was
shared in plaintext in chat at one point during development. Worth rotating
via the Supabase dashboard before or shortly after going live, independent
of anything else in this document.

## Dockerfile notes

- **Backend** (`apps/backend/Dockerfile`) must be built with the **repo
  root** as context, not `apps/backend` — it depends on the
  `@splex/shared-types` workspace package:
  `docker build -f apps/backend/Dockerfile -t splex-backend .`
- **Intelligence service** (`services/intelligence/Dockerfile`) builds
  from its own directory: `docker build -t splex-intelligence services/intelligence`.
  It bakes the BGE embedding model weights into the image at build time (a
  multi-minute build, mostly the CPU-only torch wheel) specifically so a
  cold container start doesn't pay a multi-second HuggingFace download or
  depend on that egress being reachable at request time. Final image is
  ~2.5GB, almost entirely torch + the model weights — normal for this stack,
  not a sign anything's wrong.
- Neither Dockerfile is required if your chosen platform can build directly
  from source (e.g. Railway/Render's native Node buildpack for the backend)
  — **except** the intelligence service, which needs Docker specifically
  for the `tesseract-ocr` system package; a Python-only buildpack won't
  install it.

**Three real issues found and fixed while getting these to build clean:**

1. `pnpm-workspace.yaml` was missing a build-script allowlist entry for
   `esbuild` (a transitive dep of `tsx`). Without prior interactive
   `pnpm approve-builds` history — the exact situation on any fresh CI
   runner or Docker build — `pnpm install --frozen-lockfile` hard-fails
   with `ERR_PNPM_IGNORED_BUILDS`. First fix attempt used
   `onlyBuiltDependencies`, pnpm v10's key for this — silently ignored
   (not an error) under the pnpm v11 both this repo and its Docker base
   image use. `allowBuilds: {esbuild: true}` is the correct v11 key
   (verified directly against pnpm 11.22.0, the exact version the
   container resolves via `corepack enable` with no `packageManager` pin
   in `package.json`). This fix lives in `pnpm-workspace.yaml`, so it
   protects any fresh install, not just Docker.
2. The backend's multi-stage build never copied the root
   `tsconfig.base.json` that `apps/backend/tsconfig.json` extends — caused
   a `tsc` failure, and non-obviously, a *second*, unrelated-looking type
   error alongside it (missing `lib`/`skipLibCheck` settings from the base
   config made an otherwise-fine `Buffer`/`fetch` call look like a type
   error). Fixed by copying `tsconfig.base.json` into the build stage.
3. `services/intelligence` was hardcoded to bind `127.0.0.1` only — see
   "Intelligence service" above.

## What changed today (pricing rebuild + deployment prep)

- `RAZORPAY_STARTER_PLAN_ID` was renamed to `RAZORPAY_PRO_PLAN_ID`
  throughout (env schema, billing route, the plan-creation script, local
  `.env`) — the `starter` tier (previously the active ₹299 plan) is
  retired, and `pro` (previously a dormant, never-wired ₹599 concept) is
  now the ₹299 tier, per explicit product decision. If you have this env
  var set anywhere outside this repo already, rename it there too.
- `apps/backend/.env` locally already reflects the new key name.
- `pnpm-workspace.yaml` gained an `allowBuilds` entry (see "Dockerfile
  notes") — fixes a `pnpm install --frozen-lockfile` failure that would
  otherwise hit any fresh environment with no prior local install history,
  not just Docker (a new CI runner, a teammate's first clone, etc.).

## What changed later (Razorpay removed, replaced with a fake gateway)

The `RAZORPAY_PRO_PLAN_ID` rename above is now moot — the entire Razorpay
integration was removed at the user's explicit request, not just repointed.
`razorpay` is gone from `apps/backend/package.json`,
`scripts/create-razorpay-plan.ts` is deleted, all four `RAZORPAY_*` env
vars are gone from the schema/`.env`/`.env.example`, and the raw-body
content-type parser in `server.ts` (which existed solely for webhook HMAC
verification) is gone too. See "Billing — fake gateway" above for what
replaced it.
