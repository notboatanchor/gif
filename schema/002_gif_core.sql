-- =============================================================================
-- GIF Core Schema — Migration 002
-- Applies to: gif schema (database configured via PGDATABASE)
-- Run as: gif_admin (via install.sh — do not run directly)
--
-- Sprint 3: Audit Trail Validation
--
-- Covers:
--   1. Convert audit_events to monthly partitioned table (ADR-025)
--   2. RLS INSERT-only policies on audit_events, scope_violations,
--      revocation_log (Sprint 3 enforcement layer)
--   3. user_persona_assignments stub table (ADR-021)
--
-- Data loss: existing audit_events rows are discarded. This is accepted —
-- all rows are development/test data with no production value (ADR-025).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- PART 1: Convert audit_events to a monthly partitioned table
--
-- Postgres requires the partition key (occurred_at) to be part of the
-- primary key on a partitioned table. Nothing externally references
-- audit_events.event_id, so changing the PK to (event_id, occurred_at)
-- is safe.
--
-- ADR-025: Postgres declarative partitioning, monthly intervals.
-- ---------------------------------------------------------------------------

-- Step 1a: Rename existing table so we can recreate under the same name.
-- Existing test data is discarded — accepted per ADR-025.
ALTER TABLE audit_events RENAME TO audit_events_pre_sprint3;

-- Step 1b: Drop the renamed legacy table.
-- All dependent indexes are dropped automatically.
DROP TABLE audit_events_pre_sprint3;

-- Step 1c: Create the partitioned table.
CREATE TABLE audit_events (
    event_id                UUID NOT NULL DEFAULT gen_random_uuid(),

    -- Persona and session lineage
    persona_id              UUID NOT NULL REFERENCES personas(persona_id),
    session_id              UUID REFERENCES sessions(session_id),
    invoked_by_persona_id   UUID REFERENCES personas(persona_id),

    -- Event classification
    event_type              VARCHAR(100) NOT NULL,
    -- expected values: tool_call | synthesis | export | persona_create |
    --                  persona_revoke | scope_check | human_review

    -- What was touched and what happened
    tool_name               VARCHAR(100),
    source_ref              TEXT,
    outcome                 VARCHAR(50) NOT NULL,
    flagged                 BOOLEAN NOT NULL DEFAULT false,

    -- Governance stub fields (ADR-017)
    sources_touched         JSONB,
    purpose_declared        TEXT,           -- copied from persona.purpose at session start
    sensitivity_encountered data_classification_tier,
    output_disposition      output_disposition,
    human_actor_id          UUID,

    -- Partition key — server-side clock, not settable by application
    occurred_at             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),

    -- Partition key must be included in the primary key
    PRIMARY KEY (event_id, occurred_at)

) PARTITION BY RANGE (occurred_at);

COMMENT ON TABLE audit_events IS
    'Append-only log of every AI action. No UPDATE or DELETE for application user. '
    'INSERT-only RLS enforced Sprint 3. Partitioned monthly by occurred_at (ADR-025). '
    'Timestamps from server clock — not settable by application.';

COMMENT ON COLUMN audit_events.purpose_declared IS
    'Copied from persona.purpose at the time of the audit event. '
    'Captures declared intent at action time, independent of future persona edits.';

COMMENT ON COLUMN audit_events.human_actor_id IS
    'Non-null only on human review, approval, or override events. '
    'Absence is auditable — AI-only actions are distinguishable from human-reviewed actions.';

-- Step 1d: Create initial monthly partitions.
-- Three months ahead to cover current sprint cadence.
-- New partitions must be created before the month begins — document in ops runbook.
CREATE TABLE audit_events_2026_03
    PARTITION OF audit_events
    FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');

CREATE TABLE audit_events_2026_04
    PARTITION OF audit_events
    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

CREATE TABLE audit_events_2026_05
    PARTITION OF audit_events
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

CREATE TABLE audit_events_2026_06
    PARTITION OF audit_events
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- Step 1e: Indexes on the partitioned parent — inherited by all partitions.
CREATE INDEX idx_audit_events_persona_id  ON audit_events(persona_id);
CREATE INDEX idx_audit_events_session_id  ON audit_events(session_id);
CREATE INDEX idx_audit_events_occurred_at ON audit_events(occurred_at);
CREATE INDEX idx_audit_events_event_type  ON audit_events(event_type);
CREATE INDEX idx_audit_events_flagged     ON audit_events(flagged) WHERE flagged = true;

-- Step 1f: Grants on partitioned parent and initial partitions.
-- Permission checks for queries through the parent table are evaluated on the
-- parent, not individual partitions. SELECT and INSERT only — no UPDATE.
--
-- Explicit REVOKE UPDATE is required because ALTER DEFAULT PRIVILEGES in
-- 000_post_schema_grants.sql grants SELECT, INSERT, UPDATE on all new tables.
-- Recreating the table as partitioned loses the prior REVOKE. Re-apply here
-- for both the parent and each initial partition. Repeat for future partitions.
GRANT SELECT, INSERT ON audit_events TO gif_app;
GRANT SELECT, INSERT ON audit_events_2026_03 TO gif_app;
GRANT SELECT, INSERT ON audit_events_2026_04 TO gif_app;
GRANT SELECT, INSERT ON audit_events_2026_05 TO gif_app;
GRANT SELECT, INSERT ON audit_events_2026_06 TO gif_app;

REVOKE UPDATE ON audit_events          FROM gif_app;
REVOKE UPDATE ON audit_events_2026_03  FROM gif_app;
REVOKE UPDATE ON audit_events_2026_04  FROM gif_app;
REVOKE UPDATE ON audit_events_2026_05  FROM gif_app;
REVOKE UPDATE ON audit_events_2026_06  FROM gif_app;

-- ---------------------------------------------------------------------------
-- PART 2: Row-level security on append-only audit tables
--
-- RLS is the formal enforcement layer for INSERT-only access.
-- REVOKE-based restrictions in 000_post_schema_grants.sql remain as
-- belt-and-suspenders. RLS provides enforcement even if grant configuration
-- drifts.
--
-- Pattern per table:
--   SELECT policy: gif_app may read all rows
--   INSERT policy: gif_app may insert rows (WITH CHECK true — no row filter)
--   No UPDATE or DELETE policy — operations without a matching policy are
--   rejected regardless of privilege grants.
-- ---------------------------------------------------------------------------

-- audit_events
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_events_select
    ON audit_events AS PERMISSIVE FOR SELECT TO gif_app
    USING (true);

CREATE POLICY audit_events_insert
    ON audit_events AS PERMISSIVE FOR INSERT TO gif_app
    WITH CHECK (true);

-- scope_violations
ALTER TABLE scope_violations ENABLE ROW LEVEL SECURITY;

CREATE POLICY scope_violations_select
    ON scope_violations AS PERMISSIVE FOR SELECT TO gif_app
    USING (true);

CREATE POLICY scope_violations_insert
    ON scope_violations AS PERMISSIVE FOR INSERT TO gif_app
    WITH CHECK (true);

-- revocation_log
ALTER TABLE revocation_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY revocation_log_select
    ON revocation_log AS PERMISSIVE FOR SELECT TO gif_app
    USING (true);

CREATE POLICY revocation_log_insert
    ON revocation_log AS PERMISSIVE FOR INSERT TO gif_app
    WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- PART 3: user_persona_assignments stub table
--
-- Binding layer between external user identities and GIF personas.
-- Populated empty at deployment — adopter populates as part of their
-- identity integration per ADR-021.
--
-- Required invariants (ADR-021):
--   - Admin-controlled assignment (assigned_by is non-nullable)
--   - Auditable (assigned_by, assigned_at, purpose_for_assignment required)
--   - Independently revocable from the persona itself (revoked_at lifecycle)
--   - External identity reference only (no users table in GIF)
-- ---------------------------------------------------------------------------

CREATE TABLE user_persona_assignments (
    assignment_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- External identity reference — opaque to GIF (ADR-021)
    external_user_id        VARCHAR(255) NOT NULL,

    -- Persona being assigned
    persona_id              UUID NOT NULL REFERENCES personas(persona_id),

    -- Governed assignment record — all three required per ADR-021
    assigned_by             VARCHAR(255) NOT NULL,
    assigned_at             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    purpose_for_assignment  TEXT NOT NULL,

    -- Independent revocation lifecycle — null while active
    revoked_at              TIMESTAMP WITH TIME ZONE,
    revoked_by              VARCHAR(255),

    -- Revocation consistency: both fields present or both absent
    CONSTRAINT assignment_revocation_consistent
        CHECK (
            (revoked_at IS NULL AND revoked_by IS NULL) OR
            (revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
        )
);

COMMENT ON TABLE user_persona_assignments IS
    'Binding layer between external user identities and GIF personas. '
    'Admin-controlled assignment per ADR-021 invariants. '
    'GIF has no users table — external_user_id references the adopter identity system. '
    'Populated empty at deployment; adopter populates as part of identity integration.';

COMMENT ON COLUMN user_persona_assignments.external_user_id IS
    'Opaque reference to adopter identity system (IdP, directory, or user store). '
    'GIF does not define authentication — binding references external identity only.';

COMMENT ON COLUMN user_persona_assignments.purpose_for_assignment IS
    'Required. Why this user needs this persona. '
    'Part of the governed assignment audit record (ADR-021).';

COMMENT ON COLUMN user_persona_assignments.revoked_at IS
    'Null while assignment is active. Assignment revocation is independent of '
    'persona revocation — revoking an assignment does not revoke the persona itself.';

CREATE INDEX idx_user_persona_assignments_persona_id
    ON user_persona_assignments(persona_id);

CREATE INDEX idx_user_persona_assignments_external_user
    ON user_persona_assignments(external_user_id);

-- Partial index for active assignments — common lookup path
CREATE INDEX idx_user_persona_assignments_active
    ON user_persona_assignments(external_user_id, persona_id)
    WHERE revoked_at IS NULL;

GRANT SELECT, INSERT ON user_persona_assignments TO gif_app;

COMMIT;
