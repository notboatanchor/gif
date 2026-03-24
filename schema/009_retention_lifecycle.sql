-- =============================================================================
-- GIF Schema — Migration 009
-- Retention lifecycle: holds, governed partition retirement, future partitions.
--
-- Applies to: gif database
-- Run as: psql -U postgres -d gif -f gif/schema/009_retention_lifecycle.sql
--
-- Sprint 5: Compliance Hardening — Deliverable 4
--
-- Covers:
--   1. gif.retention_holds     Legal hold table — blocks partition retirement
--   2. gif.retire_partition()  Governed stored procedure replacing manual DROP
--   3. audit_events partitions 2026_07 through 2026_12
--   4. Grants on new partitions (same pattern as migration 005)
--
-- Design rationale:
--   The ops runbook (gif/docs/ops-runbook-audit-retention.md) previously
--   documented a manual DROP TABLE pattern for retiring aged partitions.
--   This migration replaces that with a governed stored procedure that:
--     - Checks for active legal holds before allowing retirement
--     - Automatically inserts into erasure_log (the trigger deferred in 003)
--     - Executes the DROP atomically within a transaction
--   The procedure is SECURITY DEFINER owned by gif_admin (ADR-032).
--   gif_admin owns all GIF tables (migrations run as gif_admin), so SECURITY
--   DEFINER functions owned by gif_admin have SELECT/DROP on all partitions
--   without superuser dependency. EXECUTE is revoked from gif_app/research_app/
--   PUBLIC; only gif_admin and the Postgres superuser can call the procedure.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- PART 1: retention_holds
--
-- Legal holds block partition retirement and GDPR erasure for named
-- personas or external users. An active hold (released_at IS NULL) prevents
-- gif.retire_partition() from proceeding.
--
-- The application can INSERT a hold (e.g. on legal instruction). Only
-- gif_admin can UPDATE to release a hold — application users cannot
-- release their own holds (no UPDATE grant).
-- ---------------------------------------------------------------------------

CREATE TABLE gif.retention_holds (
    hold_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    created_by       VARCHAR(255) NOT NULL,
    -- Identity of the operator or process placing the hold.

    -- What is subject to the hold — at least one must be non-null
    persona_id       UUID REFERENCES gif.personas(persona_id),
    -- Hold on a specific persona's audit records.

    external_user_id VARCHAR(255),
    -- Hold on all personas ever assigned to this external_user_id
    -- (resolved via user_persona_assignments at retirement time).
    -- Use when the data subject reference is the user, not a specific persona.

    -- Why
    hold_reason      TEXT NOT NULL,
    legal_matter_ref VARCHAR(255),
    -- Optional external case/matter reference (legal case number, ticket ID, etc.)

    -- Release lifecycle — all three null while hold is active
    released_at      TIMESTAMP WITH TIME ZONE,
    released_by      VARCHAR(255),
    release_reason   TEXT,

    CONSTRAINT hold_release_consistent CHECK (
        (released_at IS NULL AND released_by IS NULL AND release_reason IS NULL) OR
        (released_at IS NOT NULL AND released_by IS NOT NULL AND release_reason IS NOT NULL)
    ),

    CONSTRAINT hold_target_present CHECK (
        persona_id IS NOT NULL OR external_user_id IS NOT NULL
    )
);

COMMENT ON TABLE gif.retention_holds IS
    'Legal holds that block partition retirement and GDPR erasure operations. '
    'gif_app can INSERT holds (e.g. on legal instruction). Only gif_admin can '
    'release holds (UPDATE). Active holds (released_at IS NULL) prevent '
    'gif.retire_partition() from proceeding.';

COMMENT ON COLUMN gif.retention_holds.persona_id IS
    'If non-null, holds all audit records for this specific persona. '
    'At least one of persona_id or external_user_id must be non-null.';

COMMENT ON COLUMN gif.retention_holds.external_user_id IS
    'If non-null, holds all audit records for all personas ever assigned to '
    'this external_user_id (resolved via user_persona_assignments). '
    'Use when the data subject reference is the user identity, not a specific persona.';

-- gif_app: INSERT and SELECT, no UPDATE (cannot release own holds)
-- Adopter layer users (research_app, etc.) are granted access by their own bootstrap scripts.
GRANT SELECT, INSERT ON gif.retention_holds TO gif_app;

ALTER TABLE gif.retention_holds ENABLE ROW LEVEL SECURITY;

CREATE POLICY retention_holds_select_gif_app
    ON gif.retention_holds AS PERMISSIVE FOR SELECT TO gif_app
    USING (true);

CREATE POLICY retention_holds_insert_gif_app
    ON gif.retention_holds AS PERMISSIVE FOR INSERT TO gif_app
    WITH CHECK (true);

-- Indexes
CREATE INDEX idx_retention_holds_persona_id
    ON gif.retention_holds(persona_id)
    WHERE persona_id IS NOT NULL;

CREATE INDEX idx_retention_holds_external_user_id
    ON gif.retention_holds(external_user_id)
    WHERE external_user_id IS NOT NULL;

-- Partial index for active holds — the common lookup in retire_partition()
CREATE INDEX idx_retention_holds_active
    ON gif.retention_holds(hold_id)
    WHERE released_at IS NULL;

-- ---------------------------------------------------------------------------
-- PART 2: gif.retire_partition()
--
-- Governed stored procedure for retiring aged audit_events partitions.
-- Replaces the manual DROP TABLE template in ops-runbook-audit-retention.md.
--
-- Steps:
--   1. Verify the partition exists in the gif schema
--   2. Get all persona_ids with events in the partition
--   3. Check for active retention_holds on those personas / their users
--   4. If any active holds exist, RAISE EXCEPTION — retirement blocked
--   5. Count rows and persona set for erasure_log
--   6. INSERT into erasure_log (satisfies the deferred trigger from migration 003)
--   7. DROP the partition
--
-- SECURITY DEFINER owned by gif_admin: runs as gif_admin regardless of caller.
-- REVOKE EXECUTE from gif_app/research_app: only operators can call this.
--
-- Usage:
--   CALL gif.retire_partition('audit_events_2026_03', 'scott', 'Retention expiry — 90 days');
--   CALL gif.retire_partition('audit_events_2026_03', 'scott', 'Retention expiry', 'TICKET-123');
-- ---------------------------------------------------------------------------

CREATE OR REPLACE PROCEDURE gif.retire_partition(
    p_partition_name  TEXT,
    p_operator        VARCHAR(255),
    p_erasure_reason  TEXT,
    p_request_ref     VARCHAR(255) DEFAULT NULL
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = gif, pg_temp
AS $$
DECLARE
    v_partition_exists BOOLEAN;
    v_persona_ids      UUID[];
    v_row_count        BIGINT;
    v_hold_count       INTEGER;
    v_hold_detail      TEXT;
BEGIN
    -- Step 1: Verify the partition exists in the gif schema
    SELECT EXISTS(
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = p_partition_name
          AND n.nspname = 'gif'
          AND c.relkind = 'r'  -- ordinary table (partition)
    ) INTO v_partition_exists;

    IF NOT v_partition_exists THEN
        RAISE EXCEPTION 'Partition gif.% does not exist', p_partition_name;
    END IF;

    -- Step 2: Collect all persona_ids and row count from the partition
    EXECUTE format(
        'SELECT array_agg(DISTINCT persona_id), count(*) FROM gif.%I',
        p_partition_name
    ) INTO v_persona_ids, v_row_count;

    -- Partition may be empty — that is a valid retirement case
    IF v_persona_ids IS NULL THEN
        v_persona_ids := '{}';
    END IF;

    -- Step 3: Check for active retention holds
    IF array_length(v_persona_ids, 1) > 0 THEN
        SELECT count(*) INTO v_hold_count
        FROM gif.retention_holds rh
        WHERE rh.released_at IS NULL
          AND (
              -- Direct persona hold
              rh.persona_id = ANY(v_persona_ids)
              OR
              -- User-level hold: any user ever assigned to one of these personas
              rh.external_user_id IN (
                  SELECT upa.external_user_id
                  FROM gif.user_persona_assignments upa
                  WHERE upa.persona_id = ANY(v_persona_ids)
              )
          );

        IF v_hold_count > 0 THEN
            SELECT string_agg(
                format('hold_id=%s reason=%s', rh.hold_id, rh.hold_reason),
                '; '
            ) INTO v_hold_detail
            FROM gif.retention_holds rh
            WHERE rh.released_at IS NULL
              AND (
                  rh.persona_id = ANY(v_persona_ids)
                  OR rh.external_user_id IN (
                      SELECT upa.external_user_id
                      FROM gif.user_persona_assignments upa
                      WHERE upa.persona_id = ANY(v_persona_ids)
                  )
              );

            RAISE EXCEPTION
                'Retirement of partition % blocked by % active hold(s): %',
                p_partition_name, v_hold_count, v_hold_detail;
        END IF;
    END IF;

    -- Step 4: Insert erasure_log record (satisfies migration 003 deferred trigger)
    INSERT INTO gif.erasure_log (
        operator,
        persona_ids,
        rows_deleted,
        erasure_reason,
        request_reference
    ) VALUES (
        p_operator,
        v_persona_ids,
        v_row_count,
        p_erasure_reason,
        p_request_ref
    );

    -- Step 5: Drop the partition
    -- quote_ident prevents SQL injection on the partition name
    EXECUTE format('DROP TABLE gif.%I', p_partition_name);

    RAISE NOTICE
        'Partition gif.% retired. % rows across % personas logged to erasure_log.',
        p_partition_name,
        v_row_count,
        array_length(v_persona_ids, 1);
END;
$$;

ALTER PROCEDURE gif.retire_partition(TEXT, VARCHAR, TEXT, VARCHAR)
    OWNER TO gif_admin;

COMMENT ON PROCEDURE gif.retire_partition IS
    'Governed partition retirement. Checks active retention_holds, inserts '
    'erasure_log record, then drops the partition. SECURITY DEFINER owned by '
    'gif_admin (table owner per ADR-032) — has SELECT/DROP on all partitions '
    'it created. gif_app and research_app are denied EXECUTE. '
    'Replaces the manual DROP TABLE template in ops-runbook-audit-retention.md.';

-- Deny application users from calling the procedure
REVOKE EXECUTE ON PROCEDURE gif.retire_partition(TEXT, VARCHAR, TEXT, VARCHAR)
    FROM gif_app;
REVOKE EXECUTE ON PROCEDURE gif.retire_partition(TEXT, VARCHAR, TEXT, VARCHAR)
    FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- PART 3: audit_events partitions 2026_07 through 2026_12
--
-- Extends coverage through year-end 2026 for FederalGraph sprints 9–12.
-- Each partition needs grants for gif_app and research_app, and REVOKE UPDATE.
-- See migration 005 note: explicit grants are safer than relying on ALTER
-- DEFAULT PRIVILEGES for partition tables.
--
-- Partitions may already exist (research pipeline migration 003 created them
-- as Q3/Q4 coverage). CREATE TABLE is wrapped in conditional DO blocks.
-- GRANT and REVOKE are idempotent — safe to re-run.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE c.relname = 'audit_events_2026_07' AND n.nspname = 'gif') THEN
    CREATE TABLE gif.audit_events_2026_07
        PARTITION OF gif.audit_events
        FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE c.relname = 'audit_events_2026_08' AND n.nspname = 'gif') THEN
    CREATE TABLE gif.audit_events_2026_08
        PARTITION OF gif.audit_events
        FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE c.relname = 'audit_events_2026_09' AND n.nspname = 'gif') THEN
    CREATE TABLE gif.audit_events_2026_09
        PARTITION OF gif.audit_events
        FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE c.relname = 'audit_events_2026_10' AND n.nspname = 'gif') THEN
    CREATE TABLE gif.audit_events_2026_10
        PARTITION OF gif.audit_events
        FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE c.relname = 'audit_events_2026_11' AND n.nspname = 'gif') THEN
    CREATE TABLE gif.audit_events_2026_11
        PARTITION OF gif.audit_events
        FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE c.relname = 'audit_events_2026_12' AND n.nspname = 'gif') THEN
    CREATE TABLE gif.audit_events_2026_12
        PARTITION OF gif.audit_events
        FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
  END IF;
END;
$$;

-- Grants on new partitions — gif_app
GRANT SELECT, INSERT ON gif.audit_events_2026_07 TO gif_app;
GRANT SELECT, INSERT ON gif.audit_events_2026_08 TO gif_app;
GRANT SELECT, INSERT ON gif.audit_events_2026_09 TO gif_app;
GRANT SELECT, INSERT ON gif.audit_events_2026_10 TO gif_app;
GRANT SELECT, INSERT ON gif.audit_events_2026_11 TO gif_app;
GRANT SELECT, INSERT ON gif.audit_events_2026_12 TO gif_app;

REVOKE UPDATE ON gif.audit_events_2026_07 FROM gif_app;
REVOKE UPDATE ON gif.audit_events_2026_08 FROM gif_app;
REVOKE UPDATE ON gif.audit_events_2026_09 FROM gif_app;
REVOKE UPDATE ON gif.audit_events_2026_10 FROM gif_app;
REVOKE UPDATE ON gif.audit_events_2026_11 FROM gif_app;
REVOKE UPDATE ON gif.audit_events_2026_12 FROM gif_app;

-- Adopter layer users (research_app, etc.) are granted access to these
-- partitions by their own bootstrap scripts.

-- RLS policies for new partitions.
-- audit_events parent RLS policies (from migrations 002 and 005) propagate to
-- partitions in Postgres 16 — no per-partition policy creation needed.

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    hold_rls_enabled  BOOLEAN;
    partition_count   INTEGER;
    proc_exists       BOOLEAN;
BEGIN
    -- Verify retention_holds RLS
    SELECT relrowsecurity INTO hold_rls_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'retention_holds' AND n.nspname = 'gif';

    IF NOT hold_rls_enabled THEN
        RAISE EXCEPTION 'RLS not enabled on gif.retention_holds';
    END IF;

    -- Verify new partitions exist (expect 6 new ones: 07-12)
    SELECT count(*) INTO partition_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname LIKE 'audit_events_2026_%'
      AND n.nspname = 'gif'
      AND c.relkind = 'r';

    -- 2026_03 through 2026_12 = 10 partitions total
    IF partition_count < 10 THEN
        RAISE EXCEPTION 'Expected at least 10 audit_events_2026_* partitions, found %', partition_count;
    END IF;

    -- Verify retire_partition procedure exists
    SELECT EXISTS(
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname = 'retire_partition'
          AND n.nspname = 'gif'
    ) INTO proc_exists;

    IF NOT proc_exists THEN
        RAISE EXCEPTION 'Procedure gif.retire_partition not found';
    END IF;

    RAISE NOTICE
        'Migration 009 verified: retention_holds ready, retire_partition procedure active, '
        '% audit_events_2026_* partitions exist',
        partition_count;
END;
$$;

COMMIT;
