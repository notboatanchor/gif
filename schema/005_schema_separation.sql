-- =============================================================================
-- GIF Schema — Migration 005
-- Database schema separation and application account model.
--
-- Run BEFORE the database rename step.
-- Applies to: gif_research database (to be renamed gif after this runs)
-- Run as: psql -U scott -d gif_research -f gif/schema/005_schema_separation.sql
--
-- What this migration does:
--   1. Creates gif_admin and research_app roles (passwords set separately)
--   2. Creates gif, research, federal schemas owned by gif_admin
--   3. Moves GIF types to gif schema
--   4. Moves GIF tables (including audit_events partitions) to gif schema
--   5. Moves Research Pipeline tables to research schema
--   6. Sets grants and search_path for gif_app, research_app
--   7. Applies RLS policies to research_app on append-only audit tables
--   8. Revokes gif_app access to public schema
--
-- After this script:
--   - Run the database rename step (separate psql session against postgres db)
--   - Update .env: MCP_POSTGRES_DB=gif, add GIF_ADMIN_PASSWORD, RESEARCH_APP_PASSWORD
--   - Update db.ts fallback from 'gif_research' to 'gif'
--   - Restart MCP server
--
-- ADR-028: Database schema separation and application account model
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- PART 1: Roles
--
-- gif_admin: schema owner and migration user. Never used at runtime.
-- research_app: Research Pipeline application user.
--
-- PASSWORDS: Both roles are created with no password set.
-- After this migration, set passwords before the next service restart:
--   ALTER ROLE gif_admin   PASSWORD '<value from password manager>';
--   ALTER ROLE research_app PASSWORD '<value from password manager>';
-- Then update .env with the new credentials.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gif_admin') THEN
        CREATE ROLE gif_admin WITH LOGIN;
        RAISE NOTICE 'gif_admin role created — set password before use';
    ELSE
        RAISE NOTICE 'gif_admin role already exists — skipping creation';
    END IF;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'research_app') THEN
        CREATE ROLE research_app WITH LOGIN;
        RAISE NOTICE 'research_app role created — set password before use';
    ELSE
        RAISE NOTICE 'research_app role already exists — skipping creation';
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- PART 2: Schemas
-- gif_admin owns the gif schema — it is the only role that runs DDL there.
-- The federal schema is scaffolded now (Sprint 9 will populate it).
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS gif      AUTHORIZATION gif_admin;
CREATE SCHEMA IF NOT EXISTS research AUTHORIZATION gif_admin;
CREATE SCHEMA IF NOT EXISTS federal  AUTHORIZATION gif_admin;

COMMENT ON SCHEMA gif IS
    'GIF core tables. Owned by gif_admin. '
    'Application users gif_app and research_app have runtime access via grants.';

COMMENT ON SCHEMA research IS
    'Research Pipeline tables. Owned by gif_admin. '
    'research_app has runtime read/write access.';

COMMENT ON SCHEMA federal IS
    'FederalGraph tables. Owned by gif_admin. '
    'Scaffolded Sprint 1; populated Sprint 9.';

-- ---------------------------------------------------------------------------
-- PART 3: Move types to gif schema
--
-- Types remain valid by OID after SET SCHEMA — existing column definitions
-- are unaffected. This ensures new DDL in gif schema resolves types cleanly.
-- ---------------------------------------------------------------------------

ALTER TYPE persona_status           SET SCHEMA gif;
ALTER TYPE governance_review_status SET SCHEMA gif;
ALTER TYPE data_classification_tier SET SCHEMA gif;
ALTER TYPE output_disposition       SET SCHEMA gif;
ALTER TYPE tool_status              SET SCHEMA gif;

-- ---------------------------------------------------------------------------
-- PART 4: Move GIF core tables to gif schema
--
-- audit_events is a partitioned table — parent and all partitions must be
-- moved individually. Partitions must be in the same schema as the parent.
-- Move partitions first, then the parent.
-- ---------------------------------------------------------------------------

-- Partition tables first
ALTER TABLE audit_events_2026_03 SET SCHEMA gif;
ALTER TABLE audit_events_2026_04 SET SCHEMA gif;
ALTER TABLE audit_events_2026_05 SET SCHEMA gif;
ALTER TABLE audit_events_2026_06 SET SCHEMA gif;

-- Partitioned parent
ALTER TABLE audit_events            SET SCHEMA gif;

-- All other GIF core tables
ALTER TABLE personas                SET SCHEMA gif;
ALTER TABLE sessions                SET SCHEMA gif;
ALTER TABLE scope_violations        SET SCHEMA gif;
ALTER TABLE delegation_chain        SET SCHEMA gif;
ALTER TABLE revocation_log          SET SCHEMA gif;
ALTER TABLE user_persona_assignments SET SCHEMA gif;
ALTER TABLE erasure_log             SET SCHEMA gif;
ALTER TABLE entities                SET SCHEMA gif;
ALTER TABLE relationships           SET SCHEMA gif;
ALTER TABLE tool_registry           SET SCHEMA gif;

-- ---------------------------------------------------------------------------
-- PART 5: Move Research Pipeline tables to research schema
-- These tables are empty — zero data migration risk.
-- ---------------------------------------------------------------------------

ALTER TABLE research_runs           SET SCHEMA research;
ALTER TABLE research_configurations SET SCHEMA research;
ALTER TABLE search_results          SET SCHEMA research;
ALTER TABLE gap_analysis            SET SCHEMA research;
ALTER TABLE synthesis_outputs       SET SCHEMA research;
ALTER TABLE source_registry         SET SCHEMA research;

-- ---------------------------------------------------------------------------
-- PART 6: gif_app grants on gif schema
--
-- Runtime grants for the GIF enforcement engine application user.
-- Mirrors the existing grants on public, now applied to the gif schema.
-- RLS policies attached to tables are preserved through SET SCHEMA.
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA gif TO gif_app;

-- gif_app requires the following on gif tables (per ADR-028 grant spec):
GRANT SELECT, INSERT ON gif.personas                 TO gif_app;
GRANT SELECT, INSERT, UPDATE ON gif.sessions         TO gif_app;
GRANT SELECT, INSERT ON gif.audit_events             TO gif_app;
GRANT SELECT, INSERT ON gif.audit_events_2026_03     TO gif_app;
GRANT SELECT, INSERT ON gif.audit_events_2026_04     TO gif_app;
GRANT SELECT, INSERT ON gif.audit_events_2026_05     TO gif_app;
GRANT SELECT, INSERT ON gif.audit_events_2026_06     TO gif_app;
GRANT SELECT, INSERT ON gif.scope_violations         TO gif_app;
GRANT SELECT, INSERT ON gif.delegation_chain         TO gif_app;
GRANT SELECT, INSERT ON gif.revocation_log           TO gif_app;
GRANT SELECT, INSERT ON gif.user_persona_assignments TO gif_app;
GRANT SELECT, INSERT ON gif.erasure_log              TO gif_app;
GRANT SELECT, INSERT ON gif.tool_registry            TO gif_app;
GRANT SELECT, INSERT, UPDATE ON gif.personas         TO gif_app;
GRANT SELECT, INSERT, UPDATE ON gif.entities         TO gif_app;
GRANT SELECT, INSERT, UPDATE ON gif.relationships    TO gif_app;

-- Preserve append-only restrictions on audit tables
REVOKE UPDATE ON gif.audit_events             FROM gif_app;
REVOKE UPDATE ON gif.audit_events_2026_03     FROM gif_app;
REVOKE UPDATE ON gif.audit_events_2026_04     FROM gif_app;
REVOKE UPDATE ON gif.audit_events_2026_05     FROM gif_app;
REVOKE UPDATE ON gif.audit_events_2026_06     FROM gif_app;
REVOKE UPDATE ON gif.scope_violations         FROM gif_app;
REVOKE UPDATE ON gif.revocation_log           FROM gif_app;
REVOKE UPDATE ON gif.delegation_chain         FROM gif_app;

-- Revoke gif_app access to public schema — all access is now via gif schema
REVOKE ALL ON SCHEMA public FROM gif_app;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM gif_app;

-- Default privileges: future gif schema tables created by gif_admin are
-- accessible to gif_app with the same pattern
ALTER DEFAULT PRIVILEGES FOR ROLE gif_admin IN SCHEMA gif
    GRANT SELECT, INSERT ON TABLES TO gif_app;

-- ---------------------------------------------------------------------------
-- PART 7: research_app grants
--
-- Full GIF enforcement engine grant set on gif schema (per ADR-028).
-- Plus read/write on research schema.
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA gif      TO research_app;
GRANT USAGE ON SCHEMA research TO research_app;

-- GIF tables — same enforcement engine grant set as gif_app
GRANT SELECT, INSERT ON gif.personas                 TO research_app;
GRANT SELECT, INSERT, UPDATE ON gif.sessions         TO research_app;
GRANT SELECT, INSERT ON gif.audit_events             TO research_app;
GRANT SELECT, INSERT ON gif.audit_events_2026_03     TO research_app;
GRANT SELECT, INSERT ON gif.audit_events_2026_04     TO research_app;
GRANT SELECT, INSERT ON gif.audit_events_2026_05     TO research_app;
GRANT SELECT, INSERT ON gif.audit_events_2026_06     TO research_app;
GRANT SELECT, INSERT ON gif.scope_violations         TO research_app;
GRANT SELECT, INSERT ON gif.delegation_chain         TO research_app;
GRANT SELECT, INSERT ON gif.revocation_log           TO research_app;
GRANT SELECT, INSERT ON gif.user_persona_assignments TO research_app;
GRANT SELECT, INSERT ON gif.tool_registry            TO research_app;

-- Preserve append-only restrictions for research_app too
REVOKE UPDATE ON gif.audit_events             FROM research_app;
REVOKE UPDATE ON gif.audit_events_2026_03     FROM research_app;
REVOKE UPDATE ON gif.audit_events_2026_04     FROM research_app;
REVOKE UPDATE ON gif.audit_events_2026_05     FROM research_app;
REVOKE UPDATE ON gif.audit_events_2026_06     FROM research_app;
REVOKE UPDATE ON gif.scope_violations         FROM research_app;
REVOKE UPDATE ON gif.revocation_log           FROM research_app;
REVOKE UPDATE ON gif.delegation_chain         FROM research_app;

-- Research Pipeline tables — full read/write for research_app
GRANT SELECT, INSERT, UPDATE ON research.research_runs           TO research_app;
GRANT SELECT, INSERT, UPDATE ON research.research_configurations TO research_app;
GRANT SELECT, INSERT, UPDATE ON research.search_results          TO research_app;
GRANT SELECT, INSERT, UPDATE ON research.gap_analysis            TO research_app;
GRANT SELECT, INSERT, UPDATE ON research.synthesis_outputs       TO research_app;
GRANT SELECT, INSERT, UPDATE ON research.source_registry         TO research_app;

-- Default privileges: future research schema tables accessible to research_app
ALTER DEFAULT PRIVILEGES FOR ROLE gif_admin IN SCHEMA research
    GRANT SELECT, INSERT, UPDATE ON TABLES TO research_app;

-- ---------------------------------------------------------------------------
-- PART 8: RLS policies for research_app on append-only audit tables
--
-- RLS policies are role-specific. The existing policies reference gif_app.
-- research_app runs the GIF enforcement engine and must also have INSERT-only
-- access to the same tables. Add equivalent policies for research_app.
-- ---------------------------------------------------------------------------

CREATE POLICY audit_events_select_research_app
    ON gif.audit_events AS PERMISSIVE FOR SELECT TO research_app
    USING (true);

CREATE POLICY audit_events_insert_research_app
    ON gif.audit_events AS PERMISSIVE FOR INSERT TO research_app
    WITH CHECK (true);

CREATE POLICY scope_violations_select_research_app
    ON gif.scope_violations AS PERMISSIVE FOR SELECT TO research_app
    USING (true);

CREATE POLICY scope_violations_insert_research_app
    ON gif.scope_violations AS PERMISSIVE FOR INSERT TO research_app
    WITH CHECK (true);

CREATE POLICY revocation_log_select_research_app
    ON gif.revocation_log AS PERMISSIVE FOR SELECT TO research_app
    USING (true);

CREATE POLICY revocation_log_insert_research_app
    ON gif.revocation_log AS PERMISSIVE FOR INSERT TO research_app
    WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- PART 9: search_path for application users
--
-- Unqualified table names in application code resolve via search_path.
-- db_read ALLOWED_READ_TABLES and all tool handlers use bare names — no
-- application code changes required.
-- ---------------------------------------------------------------------------

ALTER ROLE gif_app      SET search_path = gif;
ALTER ROLE research_app SET search_path = research, gif;

-- ---------------------------------------------------------------------------
-- PART 10: Verify
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    gif_table_count      INTEGER;
    research_table_count INTEGER;
    gif_type_count       INTEGER;
BEGIN
    SELECT count(*) INTO gif_table_count
    FROM information_schema.tables
    WHERE table_schema = 'gif' AND table_type = 'BASE TABLE';

    SELECT count(*) INTO research_table_count
    FROM information_schema.tables
    WHERE table_schema = 'research' AND table_type = 'BASE TABLE';

    SELECT count(*) INTO gif_type_count
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'gif' AND t.typtype = 'e';

    -- 11 gif tables: personas, sessions, audit_events (+4 partitions),
    -- scope_violations, delegation_chain, revocation_log,
    -- user_persona_assignments, erasure_log, entities, relationships, tool_registry
    -- Note: partitions show as BASE TABLE, parent as partitioned (excluded)
    IF gif_table_count < 10 THEN
        RAISE EXCEPTION 'Expected at least 10 tables in gif schema, found %', gif_table_count;
    END IF;

    IF research_table_count <> 6 THEN
        RAISE EXCEPTION 'Expected 6 tables in research schema, found %', research_table_count;
    END IF;

    IF gif_type_count <> 5 THEN
        RAISE EXCEPTION 'Expected 5 enum types in gif schema, found %', gif_type_count;
    END IF;

    RAISE NOTICE 'Schema migration verified: % gif tables, % research tables, % gif types',
        gif_table_count, research_table_count, gif_type_count;
END;
$$;

COMMIT;
