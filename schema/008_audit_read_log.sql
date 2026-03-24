-- =============================================================================
-- GIF Schema — Migration 008
-- Audit read log: chain of custody for audit trail access.
--
-- Applies to: gif database
-- Run as: psql -U postgres -d gif -f gif/schema/008_audit_read_log.sql
--
-- Sprint 5: Compliance Hardening — Deliverable 3
--
-- Covers:
--   gif.audit_read_log    Records every read against audit tables via the
--                         MCP enforcement layer. INSERT-only for application
--                         users. No SELECT grant to application users —
--                         the read log itself is not self-readable.
--
-- Design rationale:
--   Chain of custody requires that every access to the audit trail is itself
--   audited. This table records reads made via the db_read MCP tool when the
--   target table is an audit-class table (audit_events, scope_violations,
--   revocation_log, erasure_log, audit_chain_anchors).
--
--   Key design property: gif_app and research_app can INSERT into this table
--   but cannot SELECT from it. An operator reading the read log (as gif_admin
--   or postgres) can verify that no application user is suppressing read
--   evidence by querying the table directly. This is not achievable if the
--   application user could query and selectively delete (via INSERT-only with
--   no SELECT, they cannot even read what they wrote).
--
--   DBA-direct-query vector: if a DBA bypasses the MCP server entirely and
--   queries audit_events directly via psql, no read_log entry is created.
--   This vector is documented as out-of-scope for application-layer controls.
--   Postgres connection logging (log_connections, log_statement='all' in
--   postgresql.conf) is the appropriate control at that layer.
-- =============================================================================

BEGIN;

CREATE TABLE gif.audit_read_log (
    read_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    read_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),

    -- Who is reading (enforcement layer identity)
    reader_persona_id UUID NOT NULL REFERENCES gif.personas(persona_id),
    reader_session_id UUID REFERENCES gif.sessions(session_id),

    -- What was read
    queried_table     VARCHAR(100) NOT NULL,
    -- The table name passed to db_read. Allowlist-validated before this INSERT.

    partition_hint    VARCHAR(100),
    -- If the query returned results from a specific partition (e.g. when
    -- filters included an occurred_at range), record the inferred partition.
    -- Populated by the enforcement layer when determinable; NULL otherwise.

    filters_applied   JSONB,
    -- Filters passed to db_read, as a JSONB snapshot.
    -- Example: {"persona_id": "uuid", "event_type": "tool_call"}

    rows_returned     INTEGER NOT NULL DEFAULT 0,
    -- Row count of the result set. Zero is a valid and auditable result.

    purpose_declared  TEXT
    -- Copied from persona.purpose at read time. Captures declared intent
    -- at access time, independent of future persona edits.
);

COMMENT ON TABLE gif.audit_read_log IS
    'Chain-of-custody log for reads against audit-class tables via the MCP layer. '
    'INSERT-only for gif_app and research_app — application users cannot query '
    'their own read log (no SELECT grant). Readable by gif_admin only. '
    'DBA-direct-query reads are not captured here — use Postgres connection log.';

COMMENT ON COLUMN gif.audit_read_log.queried_table IS
    'The table name as passed to db_read. Validated against ALLOWED_READ_TABLES '
    'and the audit-class table set before this record is inserted.';

COMMENT ON COLUMN gif.audit_read_log.rows_returned IS
    'Row count of the query result. Zero queries are auditable — an audit '
    'tool that returns zero rows may be probing for the absence of records.';

-- ---------------------------------------------------------------------------
-- Grants and RLS
--
-- Critical distinction from other audit tables:
--   - Standard audit tables: SELECT and INSERT granted to application users
--   - audit_read_log: INSERT only, no SELECT for application users
--
-- Application users cannot verify what read events they've produced, closing
-- the self-suppression vector where a compromised application could read and
-- then DELETE (or simply never INSERT) its read log entries.
-- ---------------------------------------------------------------------------

-- INSERT-only — no SELECT grant.
-- ALTER DEFAULT PRIVILEGES in migration 005 grants SELECT on all future gif schema tables.
-- Explicitly revoke it here so gif_app cannot query their own read log.
-- Adopter layer users (research_app, etc.) are granted INSERT by their own bootstrap scripts.
GRANT INSERT ON gif.audit_read_log TO gif_app;
REVOKE SELECT ON gif.audit_read_log FROM gif_app;

-- RLS: INSERT policies only — no SELECT policy means application users
-- are denied even if they somehow had a SELECT grant.
ALTER TABLE gif.audit_read_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_read_log_insert_gif_app
    ON gif.audit_read_log AS PERMISSIVE FOR INSERT TO gif_app
    WITH CHECK (true);

-- Indexes
CREATE INDEX idx_audit_read_log_reader_persona_id
    ON gif.audit_read_log(reader_persona_id);

CREATE INDEX idx_audit_read_log_read_at
    ON gif.audit_read_log(read_at);

CREATE INDEX idx_audit_read_log_queried_table
    ON gif.audit_read_log(queried_table);

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    rls_enabled BOOLEAN;
    pol_count   INTEGER;
BEGIN
    SELECT relrowsecurity INTO rls_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'audit_read_log' AND n.nspname = 'gif';

    IF NOT rls_enabled THEN
        RAISE EXCEPTION 'RLS not enabled on gif.audit_read_log';
    END IF;

    SELECT count(*) INTO pol_count
    FROM pg_policies
    WHERE schemaname = 'gif' AND tablename = 'audit_read_log';

    -- 1 INSERT policy (gif_app) — no SELECT policies
    -- Adopter layer users add their own INSERT policies via their bootstrap scripts
    IF pol_count <> 1 THEN
        RAISE EXCEPTION 'Expected 1 RLS policy on audit_read_log, found %', pol_count;
    END IF;

    RAISE NOTICE 'Migration 008 verified: audit_read_log created, INSERT-only RLS, % policies', pol_count;
END;
$$;

COMMIT;
