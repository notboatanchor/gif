---
name: database-migrations
description: Safe database migration patterns — zero-downtime strategies, rollback plans, Postgres-specific patterns. Reference before writing any schema change for gif.
origin: ECC
---

# Database Migration Patterns

## Core Principles

1. **Never destructive without a plan** — DROP, RENAME, and ALTER TYPE are dangerous; always have a rollback
2. **Zero-downtime by default** — assume the app is running during migration
3. **Migrations are code** — version controlled, reviewed, tested
4. **One change per migration** — atomic and reversible

## Migration Safety Checklist

Before writing any migration:
- [ ] Can this run while the app is live? (check locks)
- [ ] What's the rollback? (write down/up pair)
- [ ] Will this cause a full table lock? (ALTER TABLE on large tables does)
- [ ] Is there a data backfill needed? (separate migration)
- [ ] Does application code need to ship before or after?

## PostgreSQL Migration Patterns

### Add a Column (safe)
```sql
-- Adding a nullable column is safe — no lock, instant
ALTER TABLE entities ADD COLUMN metadata JSONB;

-- Adding NOT NULL requires a default or backfill first
ALTER TABLE entities ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
```

### Rename a Column (breaking — use expand/contract)
```sql
-- Step 1: Add new column (deploy)
ALTER TABLE entities ADD COLUMN entity_name TEXT;

-- Step 2: Backfill (deploy or migration)
UPDATE entities SET entity_name = name;

-- Step 3: Update app code to use entity_name (deploy)

-- Step 4: Drop old column (after app no longer uses it)
ALTER TABLE entities DROP COLUMN name;
```

### Add Index (use CONCURRENTLY)
```sql
-- CONCURRENTLY builds index without locking the table
-- Cannot run inside a transaction block
CREATE INDEX CONCURRENTLY idx_entities_status ON entities(status);
```

### Add Foreign Key (use NOT VALID + VALIDATE)
```sql
-- NOT VALID skips validation of existing rows (fast)
ALTER TABLE tags
  ADD CONSTRAINT fk_tags_entity
  FOREIGN KEY (entity_id) REFERENCES entities(id)
  NOT VALID;

-- VALIDATE CONSTRAINT checks existing rows (slower but separate step)
ALTER TABLE tags VALIDATE CONSTRAINT fk_tags_entity;
```

### Rename a Table (breaking — coordinate with app code)
```sql
-- Create a view with the old name while migrating
ALTER TABLE old_name RENAME TO new_name;
CREATE VIEW old_name AS SELECT * FROM new_name;
-- Drop the view after app code is updated
```

## Up/Down Pattern

Every migration must have a clear rollback:

```sql
-- Migration: 0042_add_entity_metadata.sql
-- UP
ALTER TABLE entities ADD COLUMN metadata JSONB;
CREATE INDEX CONCURRENTLY idx_entities_metadata_gin
  ON entities USING GIN(metadata);

-- DOWN
DROP INDEX CONCURRENTLY idx_entities_metadata_gin;
ALTER TABLE entities DROP COLUMN metadata;
```

## Zero-Downtime Strategy

For large table changes:
1. **Expand** — Add new column/table, keep old one
2. **Migrate** — Dual-write to both old and new
3. **Backfill** — Copy historical data (batched, not bulk)
4. **Contract** — Remove old column/table after all readers are updated

## Batched Backfill Pattern (avoid table locks)

```sql
-- Backfill in batches to avoid locking the whole table
DO $$
DECLARE
  batch_size INT := 1000;
  last_id UUID := '00000000-0000-0000-0000-000000000000';
  rows_updated INT;
BEGIN
  LOOP
    UPDATE entities
    SET new_column = compute(old_column)
    WHERE id IN (
      SELECT id FROM entities
      WHERE new_column IS NULL AND id > last_id
      ORDER BY id LIMIT batch_size
    )
    RETURNING id INTO last_id;

    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    EXIT WHEN rows_updated = 0;
    PERFORM pg_sleep(0.1);  -- breathe between batches
  END LOOP;
END $$;
```

## gif-Specific Conventions

- Migrations live in `schema/migrations/` as `NNNN_description.sql`
- Each migration file has UP and DOWN sections as SQL comments
- Run migrations with `psql -U scott -d gif -f migration.sql`
- Always test DOWN before merging (confirm rollback works)
- CONCURRENTLY indexes cannot run inside transactions — run them separately
