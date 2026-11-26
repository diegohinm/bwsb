#!/usr/bin/env bash

set -euo pipefail

# Move to the project root
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "Starting test database setup..."

# ==========================================
# 1. Safety guard
# ==========================================

if [[ "${TEST_DATABASE:-}" != "true" ]]; then
    echo "ERROR: TEST_DATABASE must be true."
    exit 1
fi

if [[ "${NODE_ENV:-}" != "test" ]]; then
    echo "ERROR: NODE_ENV must be test."
    exit 1
fi

# ==========================================
# 2. Validate environment variables
# ==========================================

REQUIRED_VARS=(
    TEST_DATABASE_URL
    TEST_SUPABASE_URL
    TEST_SUPABASE_SERVICE_ROLE_KEY
)

for var in "${REQUIRED_VARS[@]}"; do
    if [[ -z "${!var:-}" ]]; then
        echo "ERROR: $var is missing or empty."
        exit 1
    fi

    echo "OK: $var is configured."
done

# ==========================================
# 3. Validate Supabase project
# ==========================================

node <<'JS'
try {
    const database = new URL(process.env.TEST_DATABASE_URL);
    const supabase = new URL(process.env.TEST_SUPABASE_URL);
    const projectRef = /^([a-z0-9]+)\.supabase\.co$/.exec(supabase.hostname)?.[1];
    const direct = database.hostname === `db.${projectRef}.supabase.co`;
    const pooler = database.hostname.endsWith('.pooler.supabase.com') &&
        decodeURIComponent(database.username) === `postgres.${projectRef}`;

    if (projectRef && supabase.protocol === 'https:' &&
        ['postgres:', 'postgresql:'].includes(database.protocol) &&
        (direct || pooler) && process.env.TEST_SUPABASE_SERVICE_ROLE_KEY.trim()) {
        process.exit(0);
    }
} catch {
    // URL parsing errors may contain credentials. Report only the variable names.
}
console.error('ERROR: Configure TEST_DATABASE_URL and TEST_SUPABASE_URL for the same Supabase project and set TEST_SUPABASE_SERVICE_ROLE_KEY.');
process.exit(1);
JS

# ==========================================
# 4. Map test environment variables
# ==========================================

export DATABASE_URL="$TEST_DATABASE_URL"
export SUPABASE_URL="$TEST_SUPABASE_URL"
export SUPABASE_SERVICE_ROLE_KEY="$TEST_SUPABASE_SERVICE_ROLE_KEY"

echo "Safety guard passed."

# ==========================================
# 5. Generate Prisma client
# ==========================================

echo "Generating Prisma client..."
npm run prisma:generate

# ==========================================
# 6. Deploy migrations
# ==========================================

echo "Deploying test database migrations..."
npm run prisma:migrate:deploy

# ==========================================
# 7. Seed test database
# ==========================================

echo "Seeding test database..."
npm run prisma:seed

# ==========================================
# 8. Check migration status
# ==========================================

echo "Checking migration status..."
npm run prisma:status

echo "Test database setup completed successfully."