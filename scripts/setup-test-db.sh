#!/usr/bin/env bash
#
# Prepare the dedicated Supabase TEST project for the integration suite:
#
#   guard → prisma generate → migrate deploy → seed → migrate status
#
# Usage (CI does exactly this — see the integration job in .github/workflows/ci.yml):
#
#   TEST_DATABASE=true \
#   DATABASE_URL=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
#   bash scripts/setup-test-db.sh
#
# What it deliberately does NOT do:
#   - install dependencies (`npm ci` belongs to the caller);
#   - print any secret value, or any part of one;
#   - run anything destructive: no `migrate reset`, no `migrate dev`, no
#     `db push`, no truncation. `migrate deploy` only applies pending
#     migrations from prisma/migrations/, and the seed only upserts.
#
# The guard rules are mirrored in src/__integration__/testDatabaseGuard.ts,
# which also protects `npm run test:integration` on its own. Keep them in step.

set -euo pipefail

cd "$(dirname "$0")/.."

refuse() {
  echo "ERROR: $1" >&2
  exit 1
}

# ── Guard ────────────────────────────────────────────────────────────────────
# Every check runs BEFORE the first Prisma command. The Prisma CLI fills any
# unset variable from a .env file, and a developer's .env points at the real
# project: the connection settings must therefore come from the environment.

# 1. Explicit opt-in. Not a perfect production guard — positive evidence that
#    the caller means the test project.

SUPABASE_URL: ${{ secrets.TEST_SUPABASE_URL }}

if [ "${TEST_DATABASE:-}" != "true" ]; then
  echo "ERROR: refusing to prepare database because TEST_DATABASE=true is not set" >&2
  exit 1
fi

# 2. Never with a production runtime configuration.
if [ "${NODE_ENV:-}" = "production" ]; then
  refuse "refusing to prepare database because NODE_ENV=production"
fi

# 3. Every connection setting present and non-blank.
missing=()
for name in DATABASE_URL SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY; do
  value="${!name:-}"
  if [ -z "${value//[[:space:]]/}" ]; then
    missing+=("$name")
  fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  refuse "refusing to prepare database: missing required environment variable(s): ${missing[*]}"
fi

# 4. The database must belong to the same Supabase project as the API URL.
#    The project ref (https://<ref>.supabase.co) appears in the pooler user name
#    (postgres.<ref>) or the direct host (db.<ref>.supabase.co). Only the user,
#    host and query of DATABASE_URL are compared — never the password — and
#    nothing is echoed.
if [[ "$SUPABASE_URL" =~ ^https://([A-Za-z0-9]+)\.supabase\.co/?$ ]]; then
  project_ref="${BASH_REMATCH[1]}"
  db_rest="${DATABASE_URL#*://}"
  db_userinfo="${db_rest%%@*}"
  db_user="${db_userinfo%%:*}"
  db_location="${db_rest##*@}"
  shopt -s nocasematch
  if [[ "$db_user $db_location" != *"$project_ref"* ]]; then
    refuse "refusing to prepare database: DATABASE_URL does not belong to the Supabase project named by SUPABASE_URL"
  fi
  shopt -u nocasematch
  ref_check="DATABASE_URL matches the SUPABASE_URL project"
else
  ref_check="project-ref comparison skipped (SUPABASE_URL is not a *.supabase.co URL)"
fi

echo "Test database guard passed:"
echo "  - TEST_DATABASE=true"
echo "  - NODE_ENV=${NODE_ENV:-<unset>}"
echo "  - DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY are set (values not shown)"
echo "  - ${ref_check}"

# ── Prepare ──────────────────────────────────────────────────────────────────
run() {
  echo
  echo "==> npm run $1"
  npm run "$1"
}

run prisma:generate
run prisma:migrate:deploy
run prisma:seed
run prisma:status

echo
echo "Test database ready."
