# SPLEX Production Deployment Guide

Three independently-deployable units. You're handling the frontend on Vercel
yourself — this document covers what the other two need, plus the wiring
between all three. **Nothing in this repo has been deployed anywhere as
part of preparing this document** — Dockerfiles were build-tested locally
only (`docker build`, never `run`/`push`).

## The three units

| Unit | What it is | Where it can run |
|---|---|---|
| `apps/web` | Next.js 15 frontend | Vercel (you're handling this) |
| `apps/backend` | Fastify API + SSE streaming + Cortex orchestration | Any host that runs a long-lived Node process (Railway, Render, Fly.io, a VPS, ECS/Fargate, etc.) |
| `services/intelligence` | Python/FastAPI sidecar — Tesseract OCR + BGE embeddings | Any host that supports Docker (needed for the `tesseract-ocr` apt package — no Python-only buildpack will work) |

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
| `CREDITS_PER_USD` | no | `25000` (business-tunable, not a secret) |
| `RAZORPAY_KEY_ID` | no* | **Currently a placeholder locally — see "Razorpay" below before this can work in prod** |
| `RAZORPAY_KEY_SECRET` | **yes** | **Currently a placeholder locally — see "Razorpay" below** |
| `RAZORPAY_WEBHOOK_SECRET` | **yes** | **Currently a placeholder locally — see "Razorpay" below** |
| `RAZORPAY_PRO_PLAN_ID` | no | **Currently a placeholder locally — see "Razorpay" below.** Renamed from `RAZORPAY_STARTER_PLAN_ID` today — see "What changed" |
| `INTELLIGENCE_SERVICE_URL` | no | The intelligence service's **deployed** URL, not `127.0.0.1` — ideally a private/internal network address, not a public one (see "Intelligence service" below) |
| `LOG_LEVEL` | no | `info` |

\* Razorpay's key ID is not sensitive the way the secret is (it's also used
client-side in checkout), but still shouldn't be committed to version
control.

**Backend health check:** `GET /health` → `{"status":"ok"}`.

## Intelligence service (`services/intelligence`) — environment variables

| Variable | Secret? | Value |
|---|---|---|
| `PORT` | no | Platform-injected, or defaults to `8100` |
| `HOST` | no | **Must be set to `0.0.0.0` in production.** Defaults to `127.0.0.1` (loopback-only), which was fine when the backend calls it on the same machine in local dev, but is unreachable from anywhere else — this was a real gap fixed today (`main.py`, `run.sh`) precisely because it would otherwise silently fail to be reachable once deployed. |

No Supabase/OpenRouter/Razorpay credentials needed here — it's a stateless
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

## Wiring checklist (the part that's easy to get subtly wrong)

- [ ] Backend's `FRONTEND_ORIGIN` = the exact Vercel production URL (protocol + host, no trailing slash) — a mismatch here means every request fails CORS, not a partial failure
- [ ] Frontend's `NEXT_PUBLIC_BACKEND_URL` = the backend's real public URL
- [ ] Backend's `INTELLIGENCE_SERVICE_URL` = the intelligence service's real deployed URL (private network address, per above)
- [ ] Razorpay dashboard webhook is configured to point at `<backend-public-url>/billing/webhook` — this is what actually flips a user to `pro` after checkout; without it, payment succeeds in Razorpay but SPLEX never finds out
- [ ] `RAZORPAY_PRO_PLAN_ID` is a **real** plan id, not the local placeholder (see below)

## Razorpay — must be set up for real before billing works

Locally, all four `RAZORPAY_*` values are placeholders
(`RAZORPAY_KEY_ID=rzp_test_PLACEHOLDER_NOT_REAL`, etc.) — billing has never
been exercised against the real Razorpay API this session. Before Pro
upgrades can work in production:

1. Get real Razorpay API keys (test mode first, then live mode when ready).
2. Run `apps/backend/scripts/create-razorpay-plan.ts` with those keys
   (usage instructions are in the script's header comment) to create the
   real ₹299/month Pro plan via Razorpay's API — it prints the plan id to
   set as `RAZORPAY_PRO_PLAN_ID`.
3. Configure the webhook URL + webhook secret in the Razorpay dashboard,
   pointing at your deployed backend's `/billing/webhook`.

## Database

Already fully migrated — all 11 migrations in `db/migrations/` (through
today's `0011_pricing_rebuild.sql`) are applied to the Supabase project
this app already talks to (`yxhallicacslnwwmxnhd`), including the new
Free/Pro limits and the file-upload/storage enforcement trigger. The
`uploads` Storage bucket already exists (private, confirmed today). If this
is meant to stay the one production database, there is nothing left to do
here.

If instead you want a **separate** production Supabase project (isolated
from whatever this one has accumulated during development), all 11
migrations need to be replayed there in order — several of them insert
seed data, not just schema (`model_registry` rows, `plan_limits`,
`credit_cost_bands`), so a schema-only copy isn't sufficient.

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
