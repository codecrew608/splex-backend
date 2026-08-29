#!/usr/bin/env bash
# Generates deploy/frontend/ — a fully standalone copy of apps/web with
# zero monorepo dependency: no pnpm workspace, no @splex/shared-types
# package reference (inlined at the app root and imported via the
# existing "@/*" path alias, which apps/web/tsconfig.json already maps to
# "./*" — no relative-path depth math needed, unlike the backend bundle).
# This is a generated artifact (like .next/) — apps/web stays the single
# source of truth. Re-run after frontend changes to refresh before
# redeploying.
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

OUT=deploy/frontend

# Preserve the existing lockfile across the rm -rf below.
#
# ROOT CAUSE this fixes: `rm -rf "$OUT"` deletes package-lock.json, so the
# `npm install` further down had nothing to install FROM and re-resolved
# every range against the live registry. Every dependency here is a caret
# range, and ranges resolve to whatever is newest AT THAT MOMENT — so the
# same commit produced different lockfiles at different times, and the CI
# parity gate failed on a bundle whose source had not changed at all.
#
# Observed instance: @fastify/rate-limit depends on ip-address ^10.2.0.
# The committed lockfile pinned 10.5.1; 10.7.0 was published later, so CI's
# regeneration produced exactly 3 changed lines (version/resolved/integrity)
# against an unmodified source tree.
#
# Restoring the lockfile before `npm install` makes npm honour the already
# resolved versions instead of re-resolving, which is what makes this script
# idempotent — and idempotence is precisely what the parity gate asserts.
#
# Dependency updates therefore become a DELIBERATE act (delete the lockfile,
# or run npm update, and commit the result) rather than something that
# happens silently to whoever regenerates the bundle next. That is the same
# discipline any committed lockfile implies, and it is the point.
LOCK_BACKUP=""
if [ -f "$OUT/package-lock.json" ]; then
  LOCK_BACKUP="$(mktemp)"
  cp "$OUT/package-lock.json" "$LOCK_BACKUP"
fi

rm -rf "$OUT"
mkdir -p "$OUT"

# rsync-free copy that skips dev/build artifacts and local env files —
# env vars belong in the deploy platform's own settings, never baked into
# a bundle folder.
( cd apps/web && tar cf - \
    --exclude=node_modules --exclude=.next --exclude=next-env.d.ts \
    --exclude='.env*' --exclude='*.tsbuildinfo' \
    . ) | ( cd "$OUT" && tar xf - )

cp packages/shared-types/src/index.ts "$OUT/shared-types.ts"

grep -rl '"@splex/shared-types"' "$OUT" --include='*.ts' --include='*.tsx' | while read -r file; do
  sed -i 's#"@splex/shared-types"#"@/shared-types"#g' "$file"
done

# Drop the workspace dependency line from package.json — everything else
# (including the "@/*" path alias in tsconfig.json, copied as-is) stays
# unchanged.
node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync("'"$OUT"'/package.json", "utf8"));
  p.name = "splex-frontend";
  delete p.dependencies["@splex/shared-types"];
  fs.writeFileSync("'"$OUT"'/package.json", JSON.stringify(p, null, 2) + "\n");
'

cat > "$OUT/.env.example" <<'EOF'
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_BACKEND_URL=
EOF

# Regenerate the lockfile every time so it never silently falls out of
# sync with (or gets wiped by) a fresh bundle — package-lock-only skips
# actually installing node_modules, so this stays fast.
#
# Deliberately NOT a full install, unlike scripts/bundle-backend.sh.
# The distinction is which side runs the bundler:
#
#   backend  — `wrangler deploy` bundles src/worker with esbuild ON THIS
#              MACHINE, resolving bare imports off disk, so node_modules
#              must exist locally or the deploy fails outright (it did).
#   frontend — deployed to Vercel, which clones the repo and runs its own
#              install from package.json/package-lock.json. Local
#              node_modules is never consulted, so installing it here would
#              add ~30s to every bundle for no benefit.
#
# CAVEAT: this folder also carries wrangler.jsonc + open-next.config.ts for
# an alternative Cloudflare deployment path (`npm run cf:build`). That path
# DOES bundle locally and would need a real `npm install` in this folder
# first. If the frontend ever moves from Vercel to Workers, change this line
# to a full install rather than rediscovering it as a failed deploy.

# Put the preserved lockfile back so npm installs the ALREADY RESOLVED
# versions rather than re-resolving ranges against the live registry.
# See the LOCK_BACKUP comment near the top of this script.
if [ -n "$LOCK_BACKUP" ]; then
  cp "$LOCK_BACKUP" "$OUT/package-lock.json"
  rm -f "$LOCK_BACKUP"
fi

( cd "$OUT" && npx --yes "$NPM_PIN" install --package-lock-only --silent )

echo "Bundle written to $OUT"
