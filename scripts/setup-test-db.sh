#!/usr/bin/env bash

# Prepare the dedicated Supabase TEST project for the integration suite:
# guard -> prisma generate -> migrate deploy -> seed -> migrate status

set -euo pipefail

cd "$(dirname "$0")/.."

refuse() {
  echo "ERROR: $1" >&2
  exit 1
}

echo "XXXXXXXXXXXXX" 
echo "${TEST_DATABASE_URL:-}"
#echo "${secrets.TEST_DATABASE_URL:-}"
echo "${SUPABASE_URL:-}"
echo "XXXXXXXXXXXXX"

echo "${TEST_SUPABASE_URL:-}"

echo "22222222222222"

# 1. Explicit opt-in.
if [ "${TEST_DATABASE:-}" != "true" ]; then
  refuse "refusing to prepare database because TEST_DATABASE=true is not set"
fi

# 2. Never run with production runtime configuration.
if [ "${NODE_ENV:-}" = "production" ]; then
  refuse "refusing to prepare database because NODE_ENV=production"
fi

# 3. Require TEST-only connection settings.
missing=()

for name in TEST_DATABASE_URL TEST_SUPABASE_URL TEST_SUPABASE_SERVICE_ROLE_KEY; do
  value="${!name:-}"

  if [ -z "${value//[[:space:]]/}" ]; then
    missing+=("$name")
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  refuse "refusing to prepare database: missing required environment variable(s): ${missing[*]}"
fi

# 4. Map TEST variables to the names expected by Prisma/application code.
# These exports exist only inside this script process and its child processes.
export DATABASE_URL="$TEST_DATABASE_URL"
export SUPABASE_URL="$TEST_SUPABASE_URL"
export SUPABASE_SERVICE_ROLE_KEY="$TEST_SUPABASE_SERVICE_ROLE_KEY"

# 5. Verify that DATABASE_URL belongs to the same Supabase project as SUPABASE_URL.
if [[ "$SUPABASE_URL" =~ ^https://([A-Za-z0-9]+)\.supabase\.co/?$ ]]; then
  project_ref="${BASH_REMATCH[1]}"

  db_rest="${DATABASE_URL#*://}"
  db_userinfo="${db_rest%%@*}"
  db_user="${db_userinfo%%:*}"
  db_location="${db_rest##*@}"

  shopt -s nocasematch

  if [[ "$db_user $db_location" != *"$project_ref"* ]]; then
    shopt -u nocasematch
    refuse "refusing to prepare database: TEST_DATABASE_URL does not belong to the Supabase project named by TEST_SUPABASE_URL"
  fi

  shopt -u nocasematch
  ref_check="TEST_DATABASE_URL matches the TEST_SUPABASE_URL project"
else
  ref_check="project-ref comparison skipped (TEST_SUPABASE_URL is not a *.supabase.co URL)"
fi

echo "Test database guard passed:"
echo "  - TEST_DATABASE=true"
echo "  - NODE_ENV=${NODE_ENV:-<unset>}"
echo "  - TEST_DATABASE_URL, TEST_SUPABASE_URL, TEST_SUPABASE_SERVICE_ROLE_KEY are set (values not shown)"
echo "  - ${ref_check}"

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
