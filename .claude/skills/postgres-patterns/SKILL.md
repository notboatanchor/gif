---
name: postgres-patterns
description: PostgreSQL patterns for query optimization, schema design, indexing, connection pooling, and security. Reference when writing queries or migrations for gif's Postgres layer.
origin: ECC
---

# PostgreSQL Patterns

## Connection Pooling (node-postgres)

```typescript
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,                // Max pool size
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000,
});

// Always release connections
const client = await pool.connect();
try {
  const result = await client.query("SELECT ...");
  return result.rows;
} finally {
  client.release();
}
```

## Parameterized Queries (required — no string interpolation)

```typescript
// GOOD — parameterized
const result = await pool.query(
  "SELECT * FROM entities WHERE id = $1 AND status = $2",
  [entityId, status]
);

// BAD — SQL injection risk
const result = await pool.query(
  `SELECT * FROM entities WHERE id = '${entityId}'`  // NEVER DO THIS
);
```

## Transactions

```typescript
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("INSERT INTO ...", [...]);
  await client.query("UPDATE ...", [...]);
  await client.query("COMMIT");
} catch (err) {
  await client.query("ROLLBACK");
  throw err;
} finally {
  client.release();
}
```

## Indexing Cheat Sheet

| Pattern | Index Type |
|---------|-----------|
| Equality on high-cardinality column | B-tree (default) |
| Range queries (`BETWEEN`, `>`, `<`) | B-tree |
| Full-text search | GIN with `to_tsvector` |
| JSONB containment (`@>`) | GIN |
| Array containment | GIN |
| `LIKE 'prefix%'` | B-tree |
| `LIKE '%suffix'` | None (full scan) |
| Low-cardinality with frequent reads | Partial index |

```sql
-- Composite index (order matters — most selective first)
CREATE INDEX idx_entities_status_created
  ON entities(status, created_at DESC);

-- Partial index (only index what you query)
CREATE INDEX idx_active_entities
  ON entities(created_at DESC)
  WHERE status = 'active';

-- JSONB GIN index
CREATE INDEX idx_metadata_gin ON entities USING GIN(metadata);
```

## Data Type Reference

| Use case | Type |
|----------|------|
| Primary keys | `uuid` (default to `gen_random_uuid()`) |
| Timestamps | `timestamptz` (never bare `timestamp`) |
| Money/currency | `numeric(19,4)` (never `float`) |
| Status/enum | PostgreSQL `ENUM` or `text` with CHECK constraint |
| Structured data | `jsonb` (not `json`) |
| Text search | `text` with GIN tsvector index |

## Common Anti-Patterns

```sql
-- BAD: SELECT * in production queries
SELECT * FROM entities;

-- GOOD: Explicit columns
SELECT id, name, status, created_at FROM entities;

-- BAD: N+1 — query inside a loop
FOR entity IN entities LOOP
  SELECT * FROM tags WHERE entity_id = entity.id;  -- N queries!
END LOOP;

-- GOOD: JOIN or IN clause
SELECT e.*, t.name AS tag_name
FROM entities e
LEFT JOIN tags t ON t.entity_id = e.id;

-- BAD: OFFSET pagination at scale
SELECT * FROM entities ORDER BY created_at OFFSET 10000 LIMIT 50;  -- full scan!

-- GOOD: Keyset/cursor pagination
SELECT * FROM entities
WHERE created_at < $1  -- cursor from previous page
ORDER BY created_at DESC LIMIT 50;
```

## Query Performance

```sql
-- Always EXPLAIN ANALYZE before adding indexes
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM entities WHERE status = 'active';

-- Check slow queries
SELECT query, calls, mean_exec_time, total_exec_time
FROM pg_stat_statements
ORDER BY mean_exec_time DESC LIMIT 20;
```

## gif-Specific Conventions

- All tables use `uuid` PKs with `gen_random_uuid()` default
- All tables include `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- Migrations live in `schema/` directory, sequential numbered files
- Connection pool is shared — never create per-request connections
- Run `ANALYZE` after bulk inserts in migrations
