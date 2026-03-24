-- =============================================================================
-- GIF Schema — Migration 006
-- Audit trail hash chain and external anchor table.
--
-- Applies to: gif database
-- Run as: psql -U postgres -d gif -f gif/schema/006_audit_hash_chain.sql
--
-- Sprint 5: Compliance Hardening — Deliverable 1
--
-- Covers:
--   1. Add event_hash and previous_hash columns to gif.audit_events
--   2. BEFORE INSERT trigger to compute SHA-256 hash chain (DB-layer,
--      SECURITY DEFINER, owned by gif_admin — cannot be bypassed by gif_app)
--   3. gif.audit_chain_anchors table for operator-written external anchors
--
-- Design rationale:
--   The hash chain closes the DBA/superuser attack vector. A row modified by
--   a superuser changes its preimage, producing a hash mismatch detectable by
--   any chain verifier. The chain is entirely in the DB — application code
--   (gif_app, research_app) cannot influence it regardless of compromise.
--
--   External timestamping (RFC 3161, public blockchain anchor) is layerable
--   on top via audit_chain_anchors with no schema changes required.
--
--   Postgres 11+ sha256(bytea) built-in used — no pgcrypto extension needed.
--   Postgres 16 is confirmed in the stack (CLAUDE.md).
--
-- Hash preimage (pipe-delimited, NULLs as literal 'NULL'):
--   event_id | occurred_at | persona_id | session_id | event_type |
--   tool_name | outcome | flagged | previous_hash
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- PART 1: Add hash chain columns to audit_events
--
-- Columns are added to the partitioned parent — Postgres 16 propagates
-- ALTER TABLE ADD COLUMN to all existing and future partitions automatically.
--
-- Nullable: existing dev/test rows remain unchanged. The trigger ensures all
-- new rows have non-null values. No backfill — chain starts fresh.
-- ---------------------------------------------------------------------------

ALTER TABLE gif.audit_events
    ADD COLUMN IF NOT EXISTS event_hash    CHAR(64),
    ADD COLUMN IF NOT EXISTS previous_hash CHAR(64);

COMMENT ON COLUMN gif.audit_events.event_hash IS
    'SHA-256 hex digest of this row''s payload (see preimage definition in '
    'migration 006). Computed by BEFORE INSERT trigger gif.compute_audit_event_hash(). '
    'Null only for rows inserted before migration 006 was applied.';

COMMENT ON COLUMN gif.audit_events.previous_hash IS
    'event_hash of the immediately preceding row in this month''s partition '
    '(ordered by occurred_at DESC, event_id DESC). Null for the first row in '
    'a partition or for rows inserted before migration 006.';

-- ---------------------------------------------------------------------------
-- PART 2: Hash chain trigger function
--
-- SECURITY DEFINER ensures the function runs as gif_admin regardless of which
-- application user triggers the INSERT. This prevents a compromised gif_app
-- from manipulating the chain via the trigger execution context.
--
-- SET search_path prevents search_path injection attacks in SECURITY DEFINER
-- functions (Postgres security best practice).
--
-- Never throws: if hash computation fails, inserts 'HASH_ERROR' and notifies
-- via pg_notify. Preserves the non-negotiable: audit logging never throws.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION gif.compute_audit_event_hash()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = gif, pg_temp
AS $$
DECLARE
    prev_hash CHAR(64);
    preimage  TEXT;
BEGIN
    -- Step 1: Find the most recent event_hash in this month's partition.
    -- Partition-scoped query so only current-month rows are scanned.
    BEGIN
        SELECT ae.event_hash INTO prev_hash
        FROM gif.audit_events ae
        WHERE ae.occurred_at >= date_trunc('month', NEW.occurred_at)
          AND ae.occurred_at <  date_trunc('month', NEW.occurred_at) + INTERVAL '1 month'
        ORDER BY ae.occurred_at DESC, ae.event_id DESC
        LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
        prev_hash := NULL;
    END;

    -- Step 2: Build deterministic preimage.
    -- concat_ws skips NULLs — COALESCE used to render NULL as literal 'NULL'.
    preimage := concat_ws('|',
        NEW.event_id::text,
        NEW.occurred_at::text,
        NEW.persona_id::text,
        COALESCE(NEW.session_id::text, 'NULL'),
        NEW.event_type,
        COALESCE(NEW.tool_name, 'NULL'),
        NEW.outcome,
        NEW.flagged::text,
        COALESCE(prev_hash, 'NULL')
    );

    -- Step 3: Compute SHA-256. sha256(bytea) is built-in since Postgres 11.
    BEGIN
        NEW.previous_hash := prev_hash;
        NEW.event_hash    := encode(sha256(convert_to(preimage, 'UTF8')), 'hex');
    EXCEPTION WHEN OTHERS THEN
        -- Hash computation error — allow INSERT to proceed, flag it.
        NEW.event_hash    := 'HASH_ERROR';
        NEW.previous_hash := prev_hash;
        PERFORM pg_notify(
            'audit_chain_error',
            format('Hash computation failed for event %s: %s', NEW.event_id, SQLERRM)
        );
    END;

    RETURN NEW;
END;
$$;

-- gif_admin owns all tables (migrations run as gif_admin per ADR-032).
-- SECURITY DEFINER owned by gif_admin has full SELECT on all partitions
-- because gif_admin is the table owner. No superuser dependency.
ALTER FUNCTION gif.compute_audit_event_hash() OWNER TO gif_admin;

COMMENT ON FUNCTION gif.compute_audit_event_hash() IS
    'BEFORE INSERT trigger function for gif.audit_events. '
    'Computes SHA-256 hash chain: event_hash = sha256(preimage || previous_hash). '
    'SECURITY DEFINER owned by gif_admin (table owner per ADR-032) — runs with '
    'full SELECT access on all partitions regardless of calling user. '
    'Never throws — hash error written as HASH_ERROR string with pg_notify alert.';

-- Attach trigger to the partitioned parent.
-- Postgres 13+: row-level triggers on partitioned tables propagate to all
-- existing and future partitions automatically. No per-partition trigger needed.
CREATE TRIGGER audit_events_hash_chain
    BEFORE INSERT ON gif.audit_events
    FOR EACH ROW EXECUTE FUNCTION gif.compute_audit_event_hash();

-- ---------------------------------------------------------------------------
-- PART 3: audit_chain_anchors
--
-- Append-only record of operator-written chain state snapshots.
-- An anchor is a point-in-time hash of the last event in a partition, written
-- by the operator and optionally published to an external system (git commit,
-- S3 object checksum, public blockchain OP_RETURN, etc.) to make the chain
-- independently verifiable without trusting this database.
--
-- The table itself is INSERT-only — anchors are append-only evidence, never
-- modified after creation.
-- ---------------------------------------------------------------------------

CREATE TABLE gif.audit_chain_anchors (
    anchor_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    anchored_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),

    -- The event that is the anchor point (most recent in the partition at anchor time)
    event_id       UUID NOT NULL,
    anchor_hash    CHAR(64) NOT NULL,
    -- The event_hash of event_id — the chain state at this moment in time.

    partition_name VARCHAR(100) NOT NULL,
    event_count    BIGINT NOT NULL,
    -- Total rows in the partition at anchor time.

    -- Identity of the operator who wrote this anchor
    anchored_by    VARCHAR(255) NOT NULL,

    notes          TEXT
    -- Optional. External reference, publication URL, blockchain tx hash, etc.
);

COMMENT ON TABLE gif.audit_chain_anchors IS
    'Operator-written chain state snapshots. Each anchor captures the most recent '
    'event_hash at a point in time. Anchors published to external systems enable '
    'independent chain verification without trusting this database. INSERT-only.';

COMMENT ON COLUMN gif.audit_chain_anchors.notes IS
    'Optional external reference. Examples: git commit SHA where anchor was posted, '
    'S3 object URL, blockchain transaction hash. Free text — not validated by GIF.';

-- INSERT-only for gif_app (same pattern as audit_events)
-- Adopter layer users (research_app, etc.) are granted access by their own bootstrap scripts.
GRANT SELECT, INSERT ON gif.audit_chain_anchors TO gif_app;
REVOKE UPDATE ON gif.audit_chain_anchors FROM gif_app;

ALTER TABLE gif.audit_chain_anchors ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_chain_anchors_select_gif_app
    ON gif.audit_chain_anchors AS PERMISSIVE FOR SELECT TO gif_app
    USING (true);

CREATE POLICY audit_chain_anchors_insert_gif_app
    ON gif.audit_chain_anchors AS PERMISSIVE FOR INSERT TO gif_app
    WITH CHECK (true);

-- Indexes
CREATE INDEX idx_audit_chain_anchors_partition
    ON gif.audit_chain_anchors(partition_name);

CREATE INDEX idx_audit_chain_anchors_anchored_at
    ON gif.audit_chain_anchors(anchored_at);

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    hash_col_count  INTEGER;
    trigger_exists  BOOLEAN;
    anchor_rls      BOOLEAN;
BEGIN
    -- Verify hash columns exist on parent
    SELECT count(*) INTO hash_col_count
    FROM information_schema.columns
    WHERE table_schema = 'gif'
      AND table_name   = 'audit_events'
      AND column_name  IN ('event_hash', 'previous_hash');

    IF hash_col_count <> 2 THEN
        RAISE EXCEPTION 'Expected 2 hash columns on gif.audit_events, found %', hash_col_count;
    END IF;

    -- Verify trigger exists
    SELECT EXISTS(
        SELECT 1 FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE t.tgname = 'audit_events_hash_chain'
          AND c.relname = 'audit_events'
          AND n.nspname = 'gif'
    ) INTO trigger_exists;

    IF NOT trigger_exists THEN
        RAISE EXCEPTION 'Trigger audit_events_hash_chain not found on gif.audit_events';
    END IF;

    -- Verify audit_chain_anchors has RLS enabled
    SELECT relrowsecurity INTO anchor_rls
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'audit_chain_anchors' AND n.nspname = 'gif';

    IF NOT anchor_rls THEN
        RAISE EXCEPTION 'RLS not enabled on gif.audit_chain_anchors';
    END IF;

    RAISE NOTICE 'Migration 006 verified: hash chain columns added, trigger active, anchors table ready';
END;
$$;

COMMIT;
