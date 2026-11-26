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

# node <<'JS'
# try {
#     const databaseUrl = new URL(process.env.TEST_DATABASE_URL);
#     const supabaseUrl = new URL(process.env.TEST_SUPABASE_URL);

#     const projectRef = supabaseUrl.hostname.split('.')[0];

#     const validSupabase =
#         supabaseUrl.protocol === 'https:' &&
#         supabaseUrl.hostname === `${projectRef}.supabase.co`;

#     const validProtocol =
#         ['postgres:', 'postgresql:'].includes(databaseUrl.protocol);

#     const isDirect =
#         databaseUrl.hostname === `db.${projectRef}.supabase.co`;

#     const isPooler =
#         databaseUrl.hostname.endsWith('.pooler.supabase.com') &&
#         decodeURIComponent(databaseUrl.username) === `postgres.${projectRef}`;

#     console.log("Supabase hostname:", supabaseUrl.hostname);
#     console.log("Database hostname:", databaseUrl.hostname);
#     console.log("Project reference:", projectRef);

#     console.log("Valid Supabase URL:", validSupabase);
#     console.log("Valid database protocol:", validProtocol);
#     console.log("Direct connection matches:", isDirect);
#     console.log("Pooler connection matches:", isPooler);

#     if (!validSupabase) {
#         throw new Error("Invalid TEST_SUPABASE_URL");
#     }

#     if (!validProtocol) {
#         throw new Error("Invalid database protocol");
#     }

#     if (!isDirect && !isPooler) {
#         throw new Error("Database does not match Supabase project");
#     }

#     console.log("OK: Supabase project matches database project.");

# } catch (error) {
#     console.error(
#         "ERROR:",
#         error instanceof TypeError
#             ? "Invalid URL format"
#             : error.message
#     );
#     process.exit(1);
# }
# JS

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