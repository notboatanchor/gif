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

## Before upgrading past v0.2.2: check for control characters

Releases after `v0.2.2` verify the audit chain against the full control-character
rule of the audit record contract: a hashed text field (`event_type`,
`tool_name`, `outcome`, `purpose_declared`) may not contain any Unicode control
character — C0 (U+0000–U+001F), DEL (U+007F), or **C1 (U+0080–U+009F)**. Through
`v0.2.2` the verifier rejected C0 and DEL only, so a row carrying a C1 character
verified; after the upgrade the same row is reported as **unrecomputable** and
the verifier exits non-zero. It is not reported as tampering, and nothing in the
database changes — but the row can never be made verifiable, because audit data
is never rewritten.

Two things can put a control character into a hashed field:

1. **A persona created before `v0.2.1`.** `persona_create` has rejected control
   characters since `v0.2.1`; earlier releases did not. A persona's `purpose` is
   copied into `purpose_declared` on every audit row that persona generates, so
   one persona whose purpose was pasted from a document with an embedded control
   character (NEL, U+0085, is the usual one) keeps producing unrecomputable rows
   for as long as it is active.
2. **Your own tool server calling `logAuditEvent` directly** with strings it has
   not checked. gif's own tools guard their inputs; `logAuditEvent` does not
   alter or reject what you pass it (see the constraint documented on the export
   in `mcp-server/src/enforcement.ts`).

Check both before you upgrade. Run as `gif_admin` against your gif database:

```sql
-- Personas whose purpose contains a control character.
SELECT persona_id, status, issuing_entity
  FROM gif.personas
 WHERE purpose ~ '[\u0001-\u001f\u007f-\u009f]';

-- Audit rows already carrying one in a hashed text field.
SELECT count(*)
  FROM gif.audit_events
 WHERE event_type       ~ '[\u0001-\u001f\u007f-\u009f]'
    OR tool_name        ~ '[\u0001-\u001f\u007f-\u009f]'
    OR outcome::text    ~ '[\u0001-\u001f\u007f-\u009f]'
    OR purpose_declared ~ '[\u0001-\u001f\u007f-\u009f]';
```

Both queries returning nothing means the upgrade changes no verification result
for you.

If the first query returns an **active** persona: revoke it with
`persona_revoke` and create a replacement with `persona_create`, which rejects
control characters, so the replacement's purpose is clean. Do this before
upgrading if you can — every call the old persona makes adds another row the
upgraded verifier cannot recompute.

If the second query returns a non-zero count, those rows will be listed as
unrecomputable by the upgraded verifier, permanently. Record the verifier output
and its cause; do not attempt repair. If the rows came from your own
`logAuditEvent` calls, add a guard in your tool server that rejects control
characters and unpaired surrogates in `eventType`, `toolName`, `outcome`, and
`purposeDeclared` before the call.

(The character class above also matches C0 and DEL. Rows carrying those already
fail verification on `v0.2.1` and later; the query finds them too.)

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

Run the smoke test from the [first-time-setup runbook](./first-time-setup.md#10-smoke-test)
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
