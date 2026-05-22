# GIF Upgrade Path

Audience: an operator upgrading gif from one tagged release to a newer one.

---

## Before you start: back up your database

Regardless of which path you take, back up first. This takes seconds and makes
rollback trivial.

```bash
PGPASSWORD=<GIF_APP_PASSWORD> pg_dump \
  -h localhost -p 5432 -U gif_app -d gif \
  -F c -f gif-backup-$(date +%Y%m%d-%H%M%S).pgc
```

Store the backup outside the project directory (or off-host) before proceeding.

---

## Two upgrade paths

### Path A — Fresh install (wipe and re-init)

**When to use:** development, staging, or any environment where you have no audit
data you need to preserve. This is the simplest path and the right default for
early-stage deployments.

**Steps:**

1. Stop containers and delete the data volume (destructive — all data gone):

   ```bash
   docker compose down -v
   ```

2. Pull the new tagged release:

   ```bash
   git fetch --tags
   git checkout v<new-version>
   ```

3. Rebuild and start:

   ```bash
   docker compose up -d --build
   ```

   `init-db.sh` runs from scratch. All migrations apply in order. No manual
   SQL steps required.

---

### Path B — In-place upgrade (preserves data)

**When to use:** production or any environment where audit logs must be preserved.
gif's migration tracking (added in v0.1.0 via migration 012) makes this safe:
`init-db.sh` checks `gif.schema_migrations` and applies only migrations that
have not yet been recorded. Already-applied migrations are skipped.

**Steps:**

1. Pull the new tagged release:

   ```bash
   git fetch --tags
   git checkout v<new-version>
   ```

2. Rebuild and restart. The containers update in place; the data volume is untouched:

   ```bash
   docker compose up -d --build
   ```

   On restart, `init-db.sh` runs and applies only the new migrations. Existing
   data and audit records are preserved.

**Upgrading from a release that predates migration tracking (before 012):**

If you are upgrading from a version that did not yet have `gif.schema_migrations`,
`init-db.sh` detects this automatically: if `gif.personas` exists but
`gif.schema_migrations` does not, it seeds migrations 001–011 as already applied
before proceeding. No manual intervention needed.

---

## After upgrading: verify

Confirm the new migrations are recorded:

```bash
PGPASSWORD=<GIF_ADMIN_PASSWORD> psql \
  -h localhost -p 5432 -U gif_admin -d gif \
  -c "SELECT migration_name, applied_at FROM gif.schema_migrations ORDER BY applied_at;"
```

Newly applied migrations will appear at the bottom with a recent `applied_at`
timestamp. Migrations from before the upgrade will show their original timestamps
(Path B) or be absent if you wiped (Path A, expected).

Run the smoke test from the [first-time-setup runbook](./first-time-setup.md#7-smoke-test)
to confirm the MCP server is functioning.

---

## Upgrade gif-enforcement in your tool server

`gif-enforcement` is pinned to a tag in your adopter `package.json`. After
upgrading the gif server, update the dependency to match:

1. Edit `package.json` in your tool server:

   ```json
   "gif-enforcement": "git+ssh://git@github.com/notboatanchor/gif.git#v<new-version>"
   ```

2. Reinstall and rebuild:

   ```bash
   npm install
   npm run build
   ```

3. Deploy your updated tool server.

The gif server and `gif-enforcement` package version must stay in sync. Running
a mismatched combination is unsupported.

---

## When a new gif release includes destructive schema changes

gif aims to avoid destructive schema changes after v1.0. The append-only audit
trail constraint means `audit_events` and related tables can never be
restructured with data loss — that would be a governance violation, not just a
migration concern.

If a release does include a destructive change (column removal, table rename,
constraint tightening that invalidates existing rows), it will be:

- Clearly documented in the release notes with an explicit migration window.
- Accompanied by a data migration script if existing data can be preserved.

For those releases, Path B alone is not sufficient — follow the release notes
instructions before running `docker compose up -d --build`.
