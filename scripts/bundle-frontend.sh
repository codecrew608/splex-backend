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

OUT=deploy/frontend
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
( cd "$OUT" && npm install --package-lock-only --silent )

echo "Bundle written to $OUT"
