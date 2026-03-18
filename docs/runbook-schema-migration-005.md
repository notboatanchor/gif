# Runbook: Schema Migration 005
## Database Rename, Schema Separation, Account Setup
### ADR-028 — Pre-Sprint 5 infrastructure task

---

## Overview

This runbook executes migration 005 — moving tables into `gif`, `research`, and
`federal` PostgreSQL schemas, creating `gif_admin` and `research_app` roles, and
renaming the database from `gif_research` to `gif`.

**Estimated time:** 15–20 minutes
**Downtime:** MCP server is stopped for the duration of steps 3–8.

---

## Prerequisites

- [ ] All Sprint 4 tests passing (`node test_sprint4.mjs` → 10/10)
- [ ] `gif_research` database backup confirmed current (check systemd backup log)
- [ ] New passwords for `gif_admin` and `research_app` ready in password manager

---

## Step 1 — Verify current backup

```bash
# Check last backup timestamp
systemctl status gif-backup.service
ls -lh ~/backups/gif_research*.dump 2>/dev/null || ls -lh /path/to/backups/
```

If no recent backup exists, trigger one manually before proceeding.

---

## Step 2 — Stop the MCP server

```bash
cd ~/projects/dev-stack
docker compose stop mcp-server
```

Confirm it is stopped:
```bash
docker ps | grep mcp-server
# Should show no output
```

---

## Step 3 — Run migration 005

```bash
docker exec -i $(docker ps --filter "name=postgres" --format "{{.Names}}" | head -1) \
  psql -U scott -d gif_research -f /dev/stdin \
  < ~/projects/gif-stack/gif/schema/005_schema_separation.sql
```

Expected output:
```
BEGIN
NOTICE:  gif_admin role created — set password before use
NOTICE:  research_app role created — set password before use
CREATE SCHEMA
CREATE SCHEMA
CREATE SCHEMA
ALTER TYPE  (×5)
ALTER TABLE (×16 — partitions, then all gif and research tables)
GRANT / REVOKE (multiple)
CREATE POLICY (×6)
ALTER ROLE (×2)
NOTICE:  Schema migration verified: N gif tables, 6 research tables, 5 gif types
COMMIT
```

If the script fails and rolls back, investigate the error before retrying.
Do not proceed to step 4 until this commits cleanly.

---

## Step 4 — Set role passwords

Connect to the database and set passwords for the new roles:

```bash
docker exec -it $(docker ps --filter "name=postgres" --format "{{.Names}}" | head -1) \
  psql -U scott -d gif_research
```

In the psql prompt:
```sql
ALTER ROLE gif_admin    PASSWORD '<gif_admin_password_from_password_manager>';
ALTER ROLE research_app PASSWORD '<research_app_password_from_password_manager>';
\q
```

---

## Step 5 — Rename the database

The database rename requires connecting to a different database (`postgres`),
not `gif_research` itself.

```bash
docker exec -it $(docker ps --filter "name=postgres" --format "{{.Names}}" | head -1) \
  psql -U scott -d postgres
```

In the psql prompt:
```sql
ALTER DATABASE gif_research RENAME TO gif;
\q
```

Confirm:
```bash
docker exec -i $(docker ps --filter "name=postgres" --format "{{.Names}}" | head -1) \
  psql -U scott -d postgres -c "\l" | grep gif
```

Should show `gif` in the database list, not `gif_research`.

---

## Step 6 — Update .env

In `~/projects/dev-stack/.env`, update:

```
# Change:
MCP_POSTGRES_DB=gif_research
# To:
MCP_POSTGRES_DB=gif

# Add new credentials:
GIF_ADMIN_PASSWORD=<gif_admin_password>
RESEARCH_APP_PASSWORD=<research_app_password>
```

The `POSTGRES_DB` variable (used for Postgres container initialization) should
also be updated for consistency, though it has no runtime effect once the
database exists:
```
POSTGRES_DB=gif
```

---

## Step 7 — Rebuild and restart MCP server

The `db.ts` fallback was updated from `gif_research` to `gif` in the gif-stack
commit. Rebuild to pick up the change:

```bash
cd ~/projects/dev-stack
docker compose build mcp-server
docker compose up -d mcp-server
```

Wait for startup:
```bash
sleep 3 && curl -s http://localhost:3100/health
# Expected: {"status":"ok","service":"gif-mcp-server"}
```

---

## Step 8 — Run migration validation test

```bash
cd ~/projects/gif-stack/gif/mcp-server
node test_schema_migration.mjs
```

Expected: 10/10 PASS.

If any test fails, do not proceed. Diagnose the failure against the migration
output and role grants before continuing.

---

## Step 9 — Run full Sprint 4 test suite to confirm no regression

```bash
node test_sprint4.mjs
```

Expected: 10/10 PASS.

---

## Step 10 — Commit artifacts

```bash
cd ~/projects/gif-stack
git add gif/schema/005_schema_separation.sql \
        gif/mcp-server/src/db.ts \
        gif/mcp-server/test_schema_migration.mjs \
        gif/docs/runbook-schema-migration-005.md \
        CLAUDE.md
git commit -m "chore: migration 005 — schema separation, gif database rename, account model"
git push
```

---

## Post-migration state

| Item | Before | After |
|------|--------|-------|
| Database name | `gif_research` | `gif` |
| GIF tables | `public` schema | `gif` schema |
| Research Pipeline tables | `public` schema | `research` schema |
| Application user | `gif_app` | `gif_app` (updated grants) |
| New roles | — | `gif_admin`, `research_app` |
| search_path gif_app | (default, public) | `gif` |
| search_path research_app | — | `research, gif` |

---

## Rollback

If anything goes wrong before the database rename (step 5), the migration
can be rolled back — migration 005 is wrapped in a transaction and the
rename is not yet done.

To roll back schemas/roles manually:
```sql
DROP SCHEMA gif      CASCADE;
DROP SCHEMA research CASCADE;
DROP SCHEMA federal  CASCADE;
DROP ROLE gif_admin;
DROP ROLE research_app;
-- Tables were in public before — they are now dropped by CASCADE above.
-- Restore from backup.
```

**If the rename in step 5 has already run**, restore from the pre-migration
backup. The rename itself is non-destructive but reverting requires restoring
the full dump.
