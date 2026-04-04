#!/usr/bin/env bash
# =============================================================================
# GIF Database Initializer
# Runs automatically on first `docker compose up` when the data volume is empty.
# Executed inside the postgres container via docker-entrypoint-initdb.d/.
#
# Trust auth is active during initdb — psql connections work without passwords.
# Role passwords set in step 2 take effect for all subsequent connections.
#
# Steps:
#   1. Bootstrap  — create gif_admin, gif_app roles and gif schema (superuser)
#   2. Passwords  — set role passwords from environment variables (superuser)
#   3. Migrations — run 001–012 as gif_admin (tracked; each applied once)
#
# Bootstrap detection: if gif.personas exists but gif.schema_migrations does
# not, seeds schema_migrations with 001–011 as already applied before
# proceeding. This handles existing installs upgrading to tracked migrations.
#
# To reset and re-run: docker compose down -v && docker compose up -d
# =============================================================================

set -euo pipefail

DB="${POSTGRES_DB:-gif}"

echo ""
echo "=== GIF Database Init ==="
echo "    Database: $DB"
echo ""

# ---------------------------------------------------------------------------
# Step 1: Bootstrap — roles, gif schema (superuser)
# ---------------------------------------------------------------------------

echo "  1/3  Bootstrap"
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$DB" \
    -f /schema/000_bootstrap.sql

# ---------------------------------------------------------------------------
# Step 2: Set role passwords (superuser)
# Passwords come from environment variables passed via docker-compose.yml.
# ---------------------------------------------------------------------------

echo "  2/3  Passwords"
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$DB" <<SQL
ALTER ROLE gif_admin PASSWORD '${GIF_ADMIN_PASSWORD}';
ALTER ROLE gif_app   PASSWORD '${GIF_APP_PASSWORD}';
SQL

# ---------------------------------------------------------------------------
# Step 3: GIF migrations (as gif_admin)
# Trust auth is still active — no PGPASSWORD needed here.
# gif_admin's search_path is set to gif by bootstrap, so unqualified
# table names in migrations land in the correct schema.
#
# Each migration is applied exactly once and recorded in schema_migrations.
# ---------------------------------------------------------------------------

echo "  3/3  Migrations"

# Helper: apply a single migration file and record it in schema_migrations.
# Skips silently if already recorded.
apply_migration() {
    local name=$1
    local file=$2
    ALREADY=$(psql -v ON_ERROR_STOP=1 -U gif_admin -d "$DB" -tAc \
      "SELECT EXISTS(SELECT 1 FROM gif.schema_migrations WHERE migration_name='$name');")
    if [ "$ALREADY" = "f" ]; then
        echo "       → $name (applying)"
        psql -v ON_ERROR_STOP=1 -U gif_admin -d "$DB" -f "$file"
        psql -v ON_ERROR_STOP=1 -U gif_admin -d "$DB" -c \
          "INSERT INTO gif.schema_migrations(migration_name) VALUES ('$name');"
        echo "         $name applied."
    else
        echo "       → $name (already applied, skipping)"
    fi
}

# Bootstrap detection: existing install that predates migration tracking.
# If personas exists but schema_migrations does not, seed 001–011 as applied.
MIGRATIONS_TRACKED=$(psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$DB" -tAc \
  "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema='gif' AND table_name='schema_migrations');")

PERSONAS_EXISTS=$(psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$DB" -tAc \
  "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema='gif' AND table_name='personas');")

if [ "$PERSONAS_EXISTS" = "t" ] && [ "$MIGRATIONS_TRACKED" = "f" ]; then
    echo "       Existing install detected — seeding migration history for 001–011"
    # Apply migration 012 first so the tracking table exists
    psql -v ON_ERROR_STOP=1 -U gif_admin -d "$DB" -f /schema/012_schema_migrations.sql
    for name in \
        001_gif_core.sql \
        002_gif_core.sql \
        003_gif_erasure_log.sql \
        004_tool_registry_sprint4.sql \
        005_schema_separation.sql \
        006_audit_hash_chain.sql \
        007_identity_binding.sql \
        008_audit_read_log.sql \
        009_retention_lifecycle.sql \
        010_combination_policies.sql \
        011_remove_research_pipeline_tables.sql
    do
        psql -v ON_ERROR_STOP=1 -U gif_admin -d "$DB" -c \
          "INSERT INTO gif.schema_migrations(migration_name) VALUES ('$name') ON CONFLICT DO NOTHING;"
        echo "         seeded: $name"
    done
    echo "       Seed complete."
fi

# Apply all migrations in order, skipping any already recorded.
apply_migration "001_gif_core.sql"              /schema/001_gif_core.sql
apply_migration "002_gif_core.sql"              /schema/002_gif_core.sql
apply_migration "003_gif_erasure_log.sql"       /schema/003_gif_erasure_log.sql
apply_migration "004_tool_registry_sprint4.sql" /schema/004_tool_registry_sprint4.sql
apply_migration "005_schema_separation.sql"     /schema/005_schema_separation.sql
apply_migration "006_audit_hash_chain.sql"      /schema/006_audit_hash_chain.sql
apply_migration "007_identity_binding.sql"      /schema/007_identity_binding.sql
apply_migration "008_audit_read_log.sql"        /schema/008_audit_read_log.sql
apply_migration "009_retention_lifecycle.sql"   /schema/009_retention_lifecycle.sql
apply_migration "010_combination_policies.sql"  /schema/010_combination_policies.sql
apply_migration "011_remove_research_pipeline_tables.sql" \
                                                /schema/011_remove_research_pipeline_tables.sql
apply_migration "012_schema_migrations.sql"     /schema/012_schema_migrations.sql

echo ""
echo "=== GIF Init Complete ==="
echo ""
