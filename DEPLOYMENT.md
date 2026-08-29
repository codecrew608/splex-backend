# SPLEX — deployment and operations

The authoritative description of how SPLEX is built, deployed and operated.
Written because most of this was previously only in one person's head or a
chat log.

---

## 1. Repository topology

| Path | Role |
|---|---|
| `apps/web` | **Canonical** frontend source. All frontend edits go here. |
| `apps/backend` | **Canonical** backend source (Fastify routes + Cloudflare Worker). |
| `packages/shared-types` | Types shared by both. |
| `deploy/frontend` | **Generated artifact.** Vercel's build root. |
| `deploy/backend` | **Generated artifact.** Wrangler's deploy root. |

### `deploy/` is generated — never edit it by hand

Both bundle scripts begin with `rm -rf` on their output directory, so manual
edits are destroyed on the next regeneration.

```bash
bash scripts/bundle-backend.sh
bash scripts/bundle-frontend.sh
```

The bundles exist so each deploy target is standalone: no pnpm workspace, no
`@splex/shared-types` package reference, no `extends` escaping the folder.
Vercel and Wrangler each see an ordinary, self-contained project.

**CI enforces this.** The `verify` job regenerates both bundles and fails if
the result differs from what is committed. Without that gate, a commit
touching `apps/web` would ship stale code to production while the diff looked
correct — convention alone cannot prevent it.

---

## 2. Toolchain — why the versions are pinned

| Pin | Where | Why |
|---|---|---|
| Node 22 | `.nvmrc`, `engines` | `deploy/backend/Dockerfile` builds on `node:22-slim`; CI reads `.nvmrc`. |
| pnpm 11.10.0 | `packageManager` | `pnpm/action-setup` reads it, so CI and every developer use the same pnpm. |
| npm 10.9.8 | `scripts/bundle-*.sh` | **Lockfile determinism.** npm 11 writes a `"libc"` field on native packages that npm 10 strips, producing a spurious ~200-line diff and failing the parity gate on an otherwise-identical bundle. |
| `allowBuilds` | `pnpm-workspace.yaml` | pnpm refuses install scripts unless approved. `esbuild`, `sharp` and `workerd` are required and explicitly listed — deliberately not a blanket opt-out. |

If you regenerate bundles on a different Node major, the lockfiles will
churn. The scripts pin npm internally to prevent this, but keep local Node on
22.x to match everything else.

---

## 3. Secrets

**Never** in `wrangler.jsonc`, `.env.example`, or any committed file.

### Cloudflare Worker (set once, per environment)

```bash
cd deploy/backend
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret list          # verify without revealing values
```

The Worker's env schema requires both; it returns **500 "Server
misconfigured"** on every request if either is absent — the failure is total
and immediate, not subtle.

### Vercel (frontend)

Only `NEXT_PUBLIC_*` variables. Anything else is bundled into client JS and
is therefore public.

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_BACKEND_URL`

The Supabase **anon** key is safe to expose — it is RLS-scoped by design. The
**service-role** key never belongs on the frontend under any circumstances.

### Rotation

1. Rotate at the source (Supabase dashboard → API keys; OpenRouter → keys).
2. `npx wrangler secret put <NAME>` — takes effect on the next request, no redeploy.
3. For a rotated **anon** key, update the Vercel env var and redeploy (it is
   baked in at build time).
4. Rotating the service-role key requires no frontend change: it is only ever
   held by the Worker.

---

## 4. Vercel configuration (manual, one-time)

| Setting | Value |
|---|---|
| Root Directory | `deploy/frontend` |
| Framework | Next.js (auto-detected) |
| Build / Install command | leave default — the folder ships its own `package.json` + lockfile |
| Production branch | `main` |
| Environment variables | the three `NEXT_PUBLIC_*` above |

No `vercel.json` is committed: with Root Directory set, Vercel's Next.js
detection covers everything, and an unnecessary config file is one more place
for settings to disagree.

---

## 5. Deploy order

Schema first, then the code that depends on it.

1. **Migrations** in Supabase (see §6).
2. **Merge to `main`** → Vercel builds `deploy/frontend` automatically.
3. **Worker:**
   ```bash
   cd deploy/backend
   npx wrangler deploy
   ```
4. **Verify** (see §7).
5. **Reconciliation**, only if §7 shows drift.

Ordering that actually matters:
- Migration **0028** must precede the frontend deploy — it revokes the client
  write grants the old upload flow depended on.
- Any credit reconciliation must follow the **Worker** deploy, or fresh drift
  accrues onto freshly corrected counters.

---

## 6. Migrations

Applied in order from `db/migrations/`. Everything through **0031** is live in
production as of 2026-08-29, verified directly against the database rather
than assumed (0031 flipped exactly two `thinkingmachines/*` rows to
`is_active=false`; no other row changed).

`db/reconciliation/` holds one-off data corrections. These are **not**
migrations: they are run manually, once, by a human, and are deliberately kept
out of `db/migrations/` so they can never be replayed automatically.

---

## 7. Post-deploy verification

```bash
# 1. Worker is up
curl -s https://splex-backend-worker.openspace681.workers.dev/health

# 2. CORS from the real frontend origin
curl -si -X OPTIONS https://splex-backend-worker.openspace681.workers.dev/chat \
  -H "Origin: https://splex-ai.vercel.app" \
  -H "Access-Control-Request-Method: POST" | head -5

# 3. Live logs while you send a chat message from the app
cd deploy/backend && npx wrangler tail --format pretty
```

Model failures log `status`, `providerBody`, `model` and the classification
flags. A bare `err: {}` means an old build is still deployed.

```sql
-- 4. Credit drift: counters vs the authoritative ledger. Expect zero rows.
with ledger as (
  select user_id, ((created_at at time zone 'Asia/Kolkata')::date) as day,
         sum(credits_consumed)::int as truth
  from credit_usage_logs group by 1,2
)
select uc.user_id, uc.period_start, uc.used, l.truth
from usage_counters uc
join ledger l on l.user_id = uc.user_id and l.day = uc.period_start
where uc.counter_type = 'daily_credits' and uc.used > l.truth;

-- 5. Charges that could not be applied. Expect zero rows.
select * from credit_charge_failures where resolved_at is null;
```

---

## 8. Operational routines

No scheduler exists in this stack, so these are callable functions rather
than cron jobs. Run occasionally from the SQL editor:

```sql
select public.release_stale_media_reservations();   -- frees pools pinned by abandoned video jobs
select public.prune_stale_model_health();           -- drops health windows older than 30 days
select public.prune_stale_rate_limit_buckets();     -- drops buckets older than 7 days
```

`release_stale_media_reservations()` also runs opportunistically on every
video submission, so it is a safety net rather than a requirement.

```bash
# Registry health: stale models, empty categories, single-candidate categories.
# Exits non-zero when action is needed, so it can be wired to CI or cron.
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/audit-model-registry.mjs
```

---

## 9. Known external dependencies

| Item | Status |
|---|---|
| Intelligence sidecar (`INTELLIGENCE_SERVICE_URL`) | **Not deployed.** Image OCR and file-context RAG are inert; the code detects this and reports "not configured" rather than a fault. §10 covers the deploy steps and their exact preconditions. |
| Staging environment | None. All verification is local + production. A second Worker (`splex-backend-worker-staging`) and Vercel preview would close this. |
| Free image generation | Disabled (`plan_limits` = 0) because OpenRouter currently has **no** `:free` model that outputs images. A product decision, reversible by changing that row — no code change. |
| Web search caching | **Deliberately not implemented** — see §11. |

---

## 11. Two deliberate non-implementations

Both were investigated and rejected on merit, not skipped. Recording the
reasoning so neither gets "fixed" later without re-deciding it.

### Web-search result caching

Identical searches do cost full provider price each time. Caching them
across users is nonetheless the wrong trade here:

- **Freshness is the product.** Web search is reached precisely when the
  answer must be current (prices, news, "latest"). A cache TTL long enough
  to pay for itself is long enough to serve stale answers on the one class
  of question where staleness is the failure mode.
- **Privacy.** A cross-user cache is keyed by query text, which means
  storing one user's search terms and serving their results to another.
  Search queries are among the most sensitive data this product handles.
  A per-user cache avoids that but rarely hits — users seldom repeat a
  search verbatim — so it buys almost nothing.
- **Billing consistency.** Charges are derived from *real* provider cost
  (`fetchGenerationCost`). A cache hit has no provider cost, so it would
  either charge for spend that never happened or silently serve free work
  — a billing inconsistency in exchange for a latency win.
- **No cache substrate exists.** There is no Redis and no KV binding; it
  would mean a new table plus TTL sweeps, i.e. permanent operational
  surface for a speculative saving.

Revisit only if search volume makes the spend material, and then prefer a
short-TTL, **per-user** cache with an explicit freshness carve-out for
time-sensitive intents.

### Free candidate window (2 vs 3) — left as-is, deliberately

Cortex v1 (Free) returns **2** ranked model candidates; v1.5 (paid) returns
**3**. With `general`'s first two free models both upstream-rate-limited on
2026-08-29 and its third (`minimax/minimax-m2.7:free`) answering normally,
Free `general` requests failed while a working free model sat one slot out of
reach. That is a real, measured reliability cost.

It is nonetheless **not changed here**, because the evidence says it is a
deliberate tier boundary rather than an oversight:

- `resolveCortexVersion()` maps plan tier to engine version and is documented
  as "the ONLY place plan tier maps to engine version".
- Candidate count is one of *several* coordinated v1/v1.5 differences —
  v1 also uses flat weights, no live health blending, and no category-specific
  capability fit. Raising only the count would leave a half-migrated tier.
- The code calls them "Basic fallback" (2) and "More fallback candidates" (3),
  which reads as plan copy.

Against that, the same file argues the other way: the ranked list exists so a
caller "can retry with the next candidate if the first hits a transient
upstream failure — **most relevant on the free tier**, where OpenRouter's
shared `:free` pool for a given model can get rate-limited independently of
SPLEX's own traffic (observed live, repeatedly)". So the mechanism is
documented as mattering *most* exactly where it is most restricted.

That tension is a product decision about what Free is worth, not a defect with
an objectively correct fix, so it is surfaced rather than resolved unilaterally.

**If you decide to change it**, note the measured scope: raising v1 to 3 fixes
`general` **only**. `writing` (3 candidates) and `web_search` (2) had *every*
free candidate returning 429 in the same probe, so a wider window changes
nothing for them. The alternative lever — enabling health-aware ordering for
v1 so persistently-429ing models sink — would fix `general` without changing
how many candidates Free gets, but it moves a different v1.5 feature into v1.

### Local JWT verification

Auth currently makes two calls: `auth.getUser(token)` and a `users` row
lookup for `plan_tier`. Verifying the JWT locally would remove the first.
It is not safe here, for one specific reason: `auth.getUser()` validates
the session's **server-side state**, so a signed-out or revoked session
stops working immediately. Local signature verification only proves the
token was once issued and hasn't expired — a stolen token from a
signed-out session would keep working for the remainder of its lifetime.
That is a real security regression traded for latency.

The users-table lookup can't be dropped either: `plan_tier` is what every
paywall decision reads and must come from the server.

What *was* safe, and is now done (`src/auth/resolveUser.ts`): the two calls
no longer run sequentially. The lookup is started speculatively from the
token's unverified `sub` claim, in parallel with the authoritative
verification, and its result is used **only** if the verified id matches.
A forged `sub` costs one discarded `SELECT` and cannot influence identity
or entitlements (asserted in `test/auth.test.ts`). Per-request auth latency
drops from `t(getUser) + t(select)` to `max(...)` with no security change.

---

## 10. Intelligence sidecar deployment

`services/intelligence/` — Tesseract OCR + BGE-small embeddings (`main.py`,
FastAPI). Everything the repo can do for this is done: the service now
**refuses to start** unauthenticated on any non-loopback `HOST` (a same-class
fix to the media-URL and rate-limit hardening in §2/§8 — see `main.py`'s
startup guard), every endpoint but `/health` requires a bearer token, and
both request bodies and `/embed` batch size are capped so one caller can't
exhaust the container's memory or CPU. `services/intelligence/test_main.py`
covers all of that (`.venv/bin/python test_main.py`, no pytest required).

Two things remain genuinely external — a real machine to run the container
on, and a token value only you can generate:

1. **A container platform with Docker + buildx.** `services/intelligence/cloudflare/`
   is a real, typechecked (`npm install && npm run typecheck`), deployable
   Wrangler project — but Cloudflare Containers builds the image with
   BuildKit, and `wrangler deploy --dry-run` from this repo's own dev
   machine failed with `unknown flag: --load` because its local Docker
   lacks buildx. That's this machine's Docker install, not the repo; deploy
   from a machine (or CI runner) with a current Docker + buildx, or use any
   other platform that can run `services/intelligence/Dockerfile` and route
   the backend to it.
2. **`INTELLIGENCE_SERVICE_TOKEN`.** Generate one (`openssl rand -hex 32`)
   and set it in **three** places — all three, or the deploy is either
   unreachable or unauthenticated:
   ```bash
   # a) the sidecar container reads it via container-entry.ts's envVars
   cd services/intelligence/cloudflare
   npx wrangler secret put INTELLIGENCE_SERVICE_TOKEN

   # b) the backend Worker sends it as a bearer header (intelligence/client.ts)
   cd deploy/backend
   npx wrangler secret put INTELLIGENCE_SERVICE_TOKEN

   # c) point the backend at the deployed sidecar and redeploy
   npx wrangler secret put INTELLIGENCE_SERVICE_URL   # e.g. https://splex-intelligence.<account>.workers.dev
   npx wrangler deploy
   ```
   Verify with `curl <sidecar-url>/health` — the response includes
   `"auth": "enabled"`. If it reads `"disabled"`, step (a) didn't reach the
   container; re-check the secret and redeploy the sidecar before trusting
   any OCR/RAG result.

Until both are done, `INTELLIGENCE_SERVICE_URL` should stay unset in the
Worker — leaving it unset is the fail-safe state (see `intelligence/client.ts`:
every call site distinguishes "not configured" from a genuine fault), not a
half-finished one.
