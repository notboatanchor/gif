#!/usr/bin/env bash
# =============================================================================
# gif — local integration test runner
#
# Sources .env, sets the env vars the test suite expects, then runs `npm test`
# from mcp-server/. Use this when running the full integration suite against
# the gif docker compose stack on your own machine.
#
# Prerequisites:
#   - .env populated (see .env.example)
#   - docker compose stack up: docker compose up -d
#
# Usage:
#   ./scripts/test-local.sh
#
# Customizing the MCP server port (e.g., when port 3100 is already in use on
# your machine by another gif deployment): set PORT in .env to a free port,
# e.g., PORT=3199. This script automatically uses PORT to construct
# MCP_BASE_URL, so tests connect to the right server.
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [ ! -f .env ]; then
    echo "error: .env not found at $REPO_ROOT/.env"
    echo "       cp .env.example .env, then fill in real values"
    exit 1
fi

# shellcheck disable=SC1091
set -a; . ./.env; set +a

# Defaults if .env does not set these
: "${PGPORT_HOST:=5432}"
: "${PORT:=3100}"

cd mcp-server

PGHOST=localhost \
PGPORT="$PGPORT_HOST" \
PGPASSWORD="$GIF_APP_PASSWORD" \
PGADMINPASSWORD="$GIF_ADMIN_PASSWORD" \
IDENTITY_HMAC_SECRET="$IDENTITY_HMAC_SECRET" \
MCP_BASE_URL="http://localhost:$PORT" \
    npm test
