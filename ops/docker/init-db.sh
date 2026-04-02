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
#   3. Migrations — run 001–010 as gif_admin
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
# ---------------------------------------------------------------------------

echo "  3/3  Migrations"

for migration in \
    001_gif_core.sql \
    002_gif_core.sql \
    003_gif_erasure_log.sql \
    004_tool_registry_sprint4.sql \
    005_schema_separation.sql \
    006_audit_hash_chain.sql \
    007_identity_binding.sql \
    008_audit_read_log.sql \
    009_retention_lifecycle.sql \
    010_combination_policies.sql
do
    echo "       → $migration"
    psql -v ON_ERROR_STOP=1 -U gif_admin -d "$DB" \
        -f "/schema/$migration"
done

echo ""
echo "=== GIF Init Complete ==="
echo ""
