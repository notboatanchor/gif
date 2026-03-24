#!/usr/bin/env bash
# =============================================================================
# GIF Install Script
# Bootstraps a fresh GIF database installation.
#
# Usage:
#   ./gif/scripts/install.sh
#
# Required environment variables:
#   PGHOST              Postgres host              (default: localhost)
#   PGPORT              Postgres port              (default: 5432)
#   PGDATABASE          Target database name       (default: gif)
#   POSTGRES_USER       Superuser name             (default: postgres)
#   POSTGRES_PASSWORD   Superuser password         (required)
#   GIF_ADMIN_PASSWORD  Password for gif_admin     (required)
#   GIF_APP_PASSWORD    Password for gif_app       (required)
#
# This script installs GIF only. Adopter layer installs (Research Pipeline,
# FederalGraph) are handled by their own install scripts, which run after
# this script and assume GIF is already present.
#
# For the dev environment, use dev-stack/install.sh which sources .env
# and maps variable names automatically.
#
# ADR-032: GIF ownership model and deployment topology
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ---------------------------------------------------------------------------
# Connection defaults
# ---------------------------------------------------------------------------

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGDATABASE="${PGDATABASE:-gif}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"

# ---------------------------------------------------------------------------
# Required variable checks
# ---------------------------------------------------------------------------

: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${GIF_ADMIN_PASSWORD:?GIF_ADMIN_PASSWORD is required}"
: "${GIF_APP_PASSWORD:?GIF_APP_PASSWORD is required}"

# ---------------------------------------------------------------------------
# Helpers
#
# PSQL can be overridden for environments where psql is not on the host PATH.
# Docker dev: set PSQL="docker exec -i postgres psql"
# Default: psql (assumes psql is on PATH)
# ---------------------------------------------------------------------------

PSQL="${PSQL:-psql}"

run_as_super() {
    PGPASSWORD="$POSTGRES_PASSWORD" $PSQL \
        -h "$PGHOST" -p "$PGPORT" \
        -U "$POSTGRES_USER" -d "$PGDATABASE" \
        -v ON_ERROR_STOP=1 \
        "$@"
}

run_as_admin() {
    PGPASSWORD="$GIF_ADMIN_PASSWORD" $PSQL \
        -h "$PGHOST" -p "$PGPORT" \
        -U gif_admin -d "$PGDATABASE" \
        -v ON_ERROR_STOP=1 \
        "$@"
}

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------

echo ""
echo "=== GIF Install ==="
echo "Host:     $PGHOST:$PGPORT"
echo "Database: $PGDATABASE"
echo "Super:    $POSTGRES_USER"
echo ""

# Step 1: Bootstrap — create roles and schemas (as superuser)
echo "Step 1/3  Bootstrap (roles, schemas)"
run_as_super < "$ROOT/gif/schema/000_bootstrap.sql"

# Step 2: Set role passwords (as superuser, no passwords in SQL files)
echo "Step 2/3  Set role passwords"
run_as_super <<SQL
ALTER ROLE gif_admin PASSWORD '$GIF_ADMIN_PASSWORD';
ALTER ROLE gif_app   PASSWORD '$GIF_APP_PASSWORD';
SQL

# Step 3: GIF schema migrations (as gif_admin)
echo "Step 3/3  GIF schema migrations"
GIF_MIGRATIONS=(
    "gif/schema/001_gif_core.sql"
    "gif/schema/002_gif_core.sql"
    "gif/schema/003_gif_erasure_log.sql"
    "gif/schema/004_tool_registry_sprint4.sql"
    "gif/schema/005_schema_separation.sql"
    "gif/schema/006_audit_hash_chain.sql"
    "gif/schema/007_identity_binding.sql"
    "gif/schema/008_audit_read_log.sql"
    "gif/schema/009_retention_lifecycle.sql"
    "gif/schema/010_combination_policies.sql"
)
for f in "${GIF_MIGRATIONS[@]}"; do
    echo "          → $f"
    run_as_admin < "$ROOT/$f"
done

echo ""
echo "=== GIF Install Complete ==="
echo ""
echo "Next steps:"
echo "  docker compose up -d mcp-server"
echo "  cd gif/mcp-server && npm test"
echo ""
echo "To install Research Pipeline on top of this GIF install:"
echo "  research/scripts/install.sh  (not yet written — see research/scripts/INSTALL_NOTES.md)"
echo ""
