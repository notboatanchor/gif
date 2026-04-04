# Schema Migrations

How to write, register, and test a new database migration for gif.

---

## 1. Naming convention

Files live in `schema/` and follow a strict sequential naming pattern:

```
NNN_descriptive_name.sql
```

- `NNN` is a zero-padded three-digit sequence number (e.g., `013`, `014`)
- Descriptive name: lowercase, words separated by underscores
- No table prefixes in the name — the `gif` schema provides the namespace

Examples:

```
013_persona_tags.sql
014_audit_events_index.sql
```

---

## 2. Non-destructive-first principle

Prefer additive changes:

- `CREATE TABLE IF NOT EXISTS` — new tables
- `ALTER TABLE ... ADD COLUMN` — new columns (with defaults if non-nullable)
- `CREATE INDEX CONCURRENTLY` — new indexes
- New enum values appended to the end of an existing type

**When a destructive change is truly unavoidable** (`DROP COLUMN`, `DROP TABLE`, `ALTER TYPE` removing a value, etc.), it must be in its own separate migration file — never combined with additive changes. The migration must include an explicit justification comment at the top explaining why the change is necessary and cannot be avoided. Coordinate with any adopter repos before applying.

---

## 3. Writing a migration

Every migration follows this structure:

```sql
-- Migration NNN: short description
-- Brief explanation of what this migration does and why.

BEGIN;

-- ---------------------------------------------------------------------------
-- Your DDL here
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS gif.your_table (
    id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE gif.your_table IS
    'What this table stores and its governance role.';

COMMENT ON COLUMN gif.your_table.name IS
    'Comment on any non-obvious column.';

-- Grant gif_app the minimum access it needs (see section 6).
GRANT SELECT, INSERT ON gif.your_table TO gif_app;

COMMIT;
```

Rules:

- All objects go in the `gif` schema — use qualified names (`gif.your_table`, not `your_table`)
- Comment on every table; comment on every non-obvious column
- Explicit column names everywhere — no `SELECT *`
- Wrap in `BEGIN` / `COMMIT` so the migration is atomic
- Use `IF NOT EXISTS` / `ON CONFLICT DO NOTHING` where idempotency is achievable without masking real errors

---

## 4. Registering the migration

`init-db.sh` maintains an explicit ordered call list. After writing your file, add it to the `apply_migration` call list (at the bottom of the migrations block). Append after the last entry:

```bash
apply_migration "013_your_migration.sql" /schema/013_your_migration.sql
```

The order in the call list is the apply order. It must match the numeric sequence.

**Do not add new migrations to the bootstrap detection seed block.** That block (the `for name in \` loop near the top of step 3) exists for one purpose only: seeding migrations 001–012 as already-applied on installs that predate migration tracking. It is a historical transition artifact, not a registration list. Adding a new migration there would mark it as already applied on the exact upgrade path it needs to run on.

---

## 5. Testing the migration

### Fresh install (all migrations from zero)

```bash
docker compose down -v
docker compose up -d
docker compose logs postgres
```

All 13 migrations (or however many exist) should appear as `(applying)` in sequence. Every line should end with `applied.` and no errors. Confirm your new table and grants exist:

```bash
docker compose exec postgres psql -U gif_admin -d gif -c "\d gif.your_table"
docker compose exec postgres psql -U gif_admin -d gif -c "\dp gif.your_table"
```

### Upgrade simulation (existing volume, new migration only)

Start from a running stack that has the previous migrations applied but not yours. Then rebuild and restart:

```bash
docker compose up -d --build
docker compose logs postgres
```

Your migration should show `(applying)`. All prior migrations should show `(already applied, skipping)`. Verify the table was created and the prior data is intact.

---

## 6. Grant pattern

`gif_app` is the runtime application user. Grant it only the access it needs for normal operation — follow the pattern established in existing migrations:

| Access pattern | Grant |
|---|---|
| Application reads and writes rows | `GRANT SELECT, INSERT ON gif.your_table TO gif_app;` |
| Application also needs to update rows | `GRANT SELECT, INSERT, UPDATE ON gif.your_table TO gif_app;` |
| Read-only reference table | `GRANT SELECT ON gif.your_table TO gif_app;` |
| Write-only (e.g., a strict audit log) | `GRANT INSERT ON gif.your_table TO gif_app;` |

Never grant `DELETE` or `TRUNCATE` to `gif_app` on audit-related tables. The audit trail is append-only at the database permission level — this is a structural constraint, not a policy.

`gif_admin` owns all objects in the `gif` schema and does not need explicit grants.

---

## 7. Commit convention

Schema migrations use the `schema:` commit prefix:

```
schema: add persona_tags table (013)
```

One migration per commit is the norm. If bootstrap detection changes in `init-db.sh` are included, they belong in the same commit.
