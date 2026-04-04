# Ops Runbook — Audit Retention and Erasure

**Applies to:** gif database, audit_events partitioned table
**Run as:** postgres (superuser) unless noted
**Related files:**
- `gif/ops/retire_audit_partitions.sql` — retirement eligibility report and DROP template
- `gif/schema/003_gif_erasure_log.sql` — erasure_log table definition

---

## Overview

The `audit_events` table uses monthly Postgres declarative partitioning (ADR-025).
Each partition covers one calendar month (e.g., `audit_events_2026_03` covers
2026-03-01 through 2026-03-31 inclusive).

Retention is governed by two distinct mechanisms:

| Mechanism | Trigger | Procedure |
|-----------|---------|-----------|
| Time-based retention | Retention window expires for all personas in a partition | Drop the partition (§1) |
| Right-to-erasure | Data subject request (e.g., GDPR Article 17) | Row-level delete (§2) |

These are separate operations with separate procedures. Do not conflate them.

---

## §1 — Normal Retention: Partition Retirement

### When to run

Run monthly, after provisioning next month's partition (see §3). Typically the
first working day of each month.

### Retention policy model

Each persona declares a `retention_policy` in `scope_definition` JSONB:

```json
{ "retention_policy": "30_days" }
{ "retention_policy": "1_year" }
{ "retention_policy": "7_years" }
```

Supported formats: `<n>_days`, `<n>_year`, `<n>_years`. If missing or
unrecognized, defaults to `1 year`.

**Conservative-wins rule:** A partition is retirable only when the longest
retention window across all personas with events in that partition has expired
relative to the partition's end date.

Example: `audit_events_2026_03` ends 2026-04-01. Persona A has `"30_days"`,
persona B (also with events in this partition) has `"7_years"`. The partition
is not retirable until 2033-04-01.

### Procedure

**Step 1 — Generate retirement report**

```bash
psql -U postgres -d gif_research -f gif/ops/retire_audit_partitions.sql
```

Review the output. Note partitions with `retirement_status = RETIRABLE`.

**Step 2 — Verify B2 export (if configured)**

If the B2 export extension is active (rclone configured), confirm the partition
has been exported before dropping. See ADR-025 for B2 export scope.
If B2 export is not yet configured, skip this step and note it in the log.

**Step 3 — Drop each retirable partition**

For each `RETIRABLE` partition, run individually:

```sql
-- Connect as postgres
DROP TABLE audit_events_YYYY_MM;
```

Do not use `CASCADE`. The partition has no dependents. If `CASCADE` is required,
stop and investigate.

**Step 4 — Record in erasure_log**

Insert an erasure_log record for the partition drop:

```sql
INSERT INTO erasure_log (
    operator,
    persona_ids,
    rows_deleted,
    erasure_reason,
    notes
)
SELECT
    current_user,
    ARRAY(SELECT DISTINCT persona_id FROM audit_events
          WHERE occurred_at >= '<partition_start>' AND occurred_at < '<partition_end>'),
    COUNT(*)::INTEGER,
    'Retention policy expiry — partition audit_events_YYYY_MM dropped',
    NULL
FROM audit_events
WHERE occurred_at >= '<partition_start>' AND occurred_at < '<partition_end>';
```

> **Note:** Run this query *before* dropping the partition. Once the partition
> is dropped, the persona_ids and row count cannot be recovered from audit_events.

**Step 5 — Verify**

Re-run `retire_audit_partitions.sql` and confirm the dropped partition no longer
appears in the report.

---

## §2 — Right-to-Erasure (GDPR Article 17)

### When to use

A data subject has submitted a verified erasure request. An external-user-id
in the adopter's identity system maps to one or more GIF personas, and the
request requires deletion of all associated audit records.

This procedure must be run as `postgres`, not `gif_app`. The `gif_app` role
cannot DELETE from audit tables by design (INSERT-only RLS). This is intentional:
right-to-erasure is an operator-mediated administrative action, not an
application-layer operation.

### Procedure

**Step 1 — Identify persona_ids for the data subject**

```sql
SELECT persona_id
FROM user_persona_assignments
WHERE external_user_id = '<external_user_id>';
```

Record all `persona_id` values. A data subject may have been assigned multiple
personas over time — all must be included.

**Step 2 — Count rows to be deleted**

```sql
SELECT COUNT(*) AS rows_to_delete
FROM audit_events
WHERE persona_id = ANY(ARRAY['<uuid1>', '<uuid2>']::UUID[]);
```

Confirm the count is expected. If unexpectedly large, pause and verify the
persona_ids are correct before proceeding.

**Step 3 — Record erasure intent in erasure_log before deleting**

```sql
-- Run as postgres
INSERT INTO erasure_log (
    operator,
    persona_ids,
    rows_deleted,
    erasure_reason,
    request_reference,
    external_user_id,
    notes
) VALUES (
    current_user,
    ARRAY['<uuid1>', '<uuid2>']::UUID[],
    <row_count_from_step_2>,
    'GDPR Article 17 right-to-erasure request',
    '<ticket_or_case_id>',
    '<external_user_id>',
    '<any_relevant_notes>'
);
```

**Step 4 — Delete audit records**

```sql
-- Run as postgres (gif_app cannot DELETE — by design)
DELETE FROM audit_events
WHERE persona_id = ANY(ARRAY['<uuid1>', '<uuid2>']::UUID[]);
```

Also delete from scope_violations and revocation_log if the request scope
includes those tables:

```sql
DELETE FROM scope_violations
WHERE persona_id = ANY(ARRAY['<uuid1>', '<uuid2>']::UUID[]);

DELETE FROM revocation_log
WHERE persona_id = ANY(ARRAY['<uuid1>', '<uuid2>']::UUID[]);
```

**Step 5 — Verify**

```sql
SELECT COUNT(*) FROM audit_events
WHERE persona_id = ANY(ARRAY['<uuid1>', '<uuid2>']::UUID[]);
-- Expected: 0
```

**Step 6 — Confirm erasure_log record**

```sql
SELECT erasure_id, erased_at, operator, rows_deleted, request_reference
FROM erasure_log
WHERE external_user_id = '<external_user_id>'
ORDER BY erased_at DESC
LIMIT 5;
```

### What erasure_log records and why

The erasure_log entry is not personal data. It records:
- That a deletion occurred
- When and by whom
- How many rows were deleted
- The case/request reference

GDPR does not require erasure of the record that erasure happened. This is an
operational compliance record required for demonstrating that the right-to-erasure
obligation was fulfilled.

### Bulk erasure (e.g., full data migration purge)

If running a bulk delete of many personas at once (not a data subject request):

1. Disable the Sprint 4 DELETE trigger on audit_events (once implemented):
   ```sql
   ALTER TABLE audit_events DISABLE TRIGGER trigger_erasure_log;
   ```
2. Run the DELETE.
3. Insert a single erasure_log record manually covering all affected personas.
4. Re-enable the trigger:
   ```sql
   ALTER TABLE audit_events ENABLE TRIGGER trigger_erasure_log;
   ```

---

## §3 — Partition Provisioning (Monthly Maintenance)

New partitions must be created *before* the month they cover begins. Records
arriving for a month with no partition will fail insertion.

**Provision next partition on the first working day of the preceding month.**

```sql
-- Template — substitute next month's values
CREATE TABLE audit_events_YYYY_MM
    PARTITION OF audit_events
    FOR VALUES FROM ('YYYY-MM-01') TO ('YYYY-<MM+1>-01');

GRANT SELECT, INSERT ON audit_events_YYYY_MM TO gif_app;
REVOKE UPDATE ON audit_events_YYYY_MM FROM gif_app;
```

The RLS policies are defined on the parent table (`audit_events`) and apply to
all partitions automatically. No per-partition RLS setup is required.

The REVOKE UPDATE must be applied explicitly to each new partition because
default privileges grant UPDATE to `gif_app` on all new tables. See ADR-025
and Migration 002 comments.

**Verify after creation:**

```sql
SELECT
    c.relname AS partition_name,
    pg_get_expr(c.relpartbound, c.oid) AS bounds
FROM pg_catalog.pg_inherits i
JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
JOIN pg_catalog.pg_class p ON p.oid = i.inhparent
WHERE p.relname = 'audit_events'
ORDER BY c.relname;
```

---

## §4 — Sprint 4 Deferred: Automatic Erasure Trigger

The Sprint 4 implementation plan includes a trigger on `audit_events` that
auto-populates `erasure_log` on every row DELETE. Until that trigger is
implemented, the §2 procedure requires manual erasure_log insertion *before*
the DELETE.

The trigger will:
- Fire on DELETE from audit_events (all partitions via parent)
- Insert one erasure_log row per deleted row (or one row per operation — TBD in Sprint 4)
- Capture `current_user`, `persona_id`, `occurred_at`, and `event_id`

After the trigger is implemented, steps 3 and 6 of the §2 procedure will be
replaced by trigger verification. The bulk erasure procedure (disable/enable
trigger) will remain.

---

## §5 — Monitoring Queries

**Partition coverage — are all upcoming months covered?**

```sql
SELECT
    c.relname AS partition_name,
    pg_get_expr(c.relpartbound, c.oid) AS bounds
FROM pg_catalog.pg_inherits i
JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
JOIN pg_catalog.pg_class p ON p.oid = i.inhparent
WHERE p.relname = 'audit_events'
ORDER BY c.relname DESC
LIMIT 10;
```

**Recent erasure activity:**

```sql
SELECT erased_at, operator, array_length(persona_ids, 1) AS personas,
       rows_deleted, erasure_reason, request_reference
FROM erasure_log
ORDER BY erased_at DESC
LIMIT 20;
```

**Audit event volume by partition:**

```sql
SELECT
    tableoid::regclass AS partition,
    COUNT(*) AS event_count,
    MIN(occurred_at) AS earliest,
    MAX(occurred_at) AS latest
FROM audit_events
GROUP BY tableoid
ORDER BY tableoid::regclass;
```
