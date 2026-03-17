-- =============================================================================
-- GIF Core Schema — Migration 003
-- Applies to: gif_research database
-- Run as: psql -U postgres -d gif_research -f gif/schema/003_gif_erasure_log.sql
--
-- Sprint 3 (late addition): Erasure log table stub
--
-- Covers:
--   erasure_log     Tamper-resistant record of data deletion events
--
-- Deferred to Sprint 4:
--   Trigger on audit_events DELETE that auto-populates erasure_log.
--   Manual INSERT procedures are documented in the ops runbook until
--   the trigger is implemented.
--
-- Design rationale:
--   GDPR Article 17 (right to erasure) requires deleting personal data
--   from audit_events on data subject request. The act of deletion is itself
--   an auditable compliance event — but it cannot be recorded in the table
--   being deleted from.
--
--   erasure_log is a separate append-only table, INSERT-only for gif_app,
--   that records who deleted what, when, and why.
--
--   GDPR does not require erasure of the record that erasure happened.
--   The erasure_log entry is an operational compliance record, not personal
--   data subject to further erasure.
--
--   Performance note:
--   The future trigger fires per-row on DELETE from audit_events. For normal
--   retention (partition DROP), no trigger fires — partition drops bypass
--   row-level triggers. Trigger cost is only incurred during right-to-erasure
--   operations, which are infrequent and not latency-sensitive. For bulk
--   erasure operations (e.g., full data migration purge), disable the trigger,
--   insert a single erasure_log record manually, then re-enable.
--
-- See: gif/docs/ops-runbook-audit-retention.md
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- erasure_log
--
-- Append-only record of all data deletion events affecting audit tables.
-- INSERT-only for gif_app (same RLS pattern as audit_events).
-- Populated manually until Sprint 4 trigger implementation.
-- ---------------------------------------------------------------------------

CREATE TABLE erasure_log (
    erasure_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- When and who
    erased_at               TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    operator                VARCHAR(255) NOT NULL,
    -- Postgres current_user at deletion time. Set explicitly — do not rely
    -- on DEFAULT current_user so the value is visible in the INSERT statement.

    -- What was deleted
    persona_ids             UUID[] NOT NULL,
    -- All persona_ids whose audit_events rows were deleted in this operation.
    -- Array because a single erasure request may span multiple personas
    -- (e.g., one external_user_id mapped to several personas over time).

    rows_deleted            INTEGER NOT NULL,
    -- Total audit_events rows deleted across all persona_ids in this operation.

    -- Why
    erasure_reason          TEXT NOT NULL,
    -- Human-readable reason. Examples:
    --   'GDPR Article 17 right-to-erasure request'
    --   'Retention policy expiry — partition audit_events_2026_03 dropped'
    --   'Test data purge — development environment reset'

    request_reference       VARCHAR(255),
    -- Optional. External ticket, case ID, or request number from the
    -- adopter's request tracking system. Null for non-request-driven deletions.

    -- External identity linkage (for GDPR erasure requests)
    external_user_id        VARCHAR(255),
    -- The external_user_id from user_persona_assignments whose data was erased.
    -- Null for retention-driven partition drops (no data subject request involved).

    notes                   TEXT
    -- Optional operator notes. Use for anything not captured by structured fields.
);

COMMENT ON TABLE erasure_log IS
    'Tamper-resistant record of all data deletion events affecting audit tables. '
    'INSERT-only for gif_app. Populated manually until Sprint 4 trigger. '
    'GDPR compliance record — not subject to further erasure. '
    'See gif/docs/ops-runbook-audit-retention.md for procedures.';

COMMENT ON COLUMN erasure_log.operator IS
    'Postgres current_user at deletion time. Set explicitly in INSERT — '
    'not a DEFAULT so the value is auditable in the INSERT statement itself.';

COMMENT ON COLUMN erasure_log.persona_ids IS
    'All persona_ids whose audit_events rows were deleted. '
    'Array to cover multi-persona erasure requests from a single external_user_id.';

COMMENT ON COLUMN erasure_log.external_user_id IS
    'Opaque reference to adopter identity system. '
    'Null for retention-driven partition drops. '
    'Non-null for data subject erasure requests — links to user_persona_assignments.';

-- ---------------------------------------------------------------------------
-- Grants and RLS — same pattern as audit_events
-- INSERT-only for gif_app. No UPDATE or DELETE policy.
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT ON erasure_log TO gif_app;
REVOKE UPDATE ON erasure_log FROM gif_app;

ALTER TABLE erasure_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY erasure_log_select
    ON erasure_log AS PERMISSIVE FOR SELECT TO gif_app
    USING (true);

CREATE POLICY erasure_log_insert
    ON erasure_log AS PERMISSIVE FOR INSERT TO gif_app
    WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX idx_erasure_log_erased_at         ON erasure_log(erased_at);
CREATE INDEX idx_erasure_log_external_user_id  ON erasure_log(external_user_id)
    WHERE external_user_id IS NOT NULL;

COMMIT;
