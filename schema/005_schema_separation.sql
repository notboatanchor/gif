-- Copyright 2026 Notboatanchor Labs LLC
--
-- Licensed under the Apache License, Version 2.0 (the "License");
-- you may not use this file except in compliance with the License.
-- You may obtain a copy of the License at
--
--     http://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing, software
-- distributed under the License is distributed on an "AS IS" BASIS,
-- WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
-- See the License for the specific language governing permissions and
-- limitations under the License.

-- =============================================================================
-- GIF Schema — Migration 005
-- Database schema separation: moves GIF tables into the gif schema.
--
-- Run as: gif_admin (via gif/scripts/install.sh)
--
-- What this migration does:
--   1. Ensures gif_admin role exists (idempotent — created in bootstrap)
--   2. Ensures gif schema exists (idempotent — created in bootstrap)
--   3. Moves GIF types and tables from public to gif schema (upgrade path only)
--   4. Sets gif_app grants on gif schema tables
--   5. Revokes gif_app access to public schema
--
-- Adopter layer roles (research_app, etc.) are NOT managed here.
-- Their access to gif schema tables is granted by their own bootstrap scripts.
--
-- ADR-028: Database schema separation and application account model
-- ADR-032: GIF ownership model and deployment topology
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- PART 1: Roles (idempotent)
--
-- gif_admin is created in 000_bootstrap.sql. Guard here for upgrade path
-- compatibility where bootstrap may not have been run first.
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

-- ---------------------------------------------------------------------------
-- PART 2: Schemas (idempotent)
-- gif_admin owns the gif schema — it is the only role that runs DDL there.
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS gif AUTHORIZATION gif_admin;

COMMENT ON SCHEMA gif IS
    'GIF core tables. Owned by gif_admin. '
    'gif_app has runtime access via explicit grants. '
    'Adopter layer users are granted access by their own bootstrap scripts.';

-- ---------------------------------------------------------------------------
-- PARTS 3–4: Move types and tables to gif schema (upgrade path only)
--
-- Fresh install: gif_admin runs all migrations with search_path = gif, so
-- tables and types are created directly in the gif schema. No-op here.
--
-- Upgrade path: tables exist in public schema (pre-005 dev environment).
-- SET SCHEMA moves them into gif.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'personas'
    ) THEN
        RAISE NOTICE 'Upgrade path: moving types and tables from public to gif schema';

        -- Types
        ALTER TYPE persona_status           SET SCHEMA gif;
        ALTER TYPE governance_review_status SET SCHEMA gif;
        ALTER TYPE data_classification_tier SET SCHEMA gif;
        ALTER TYPE output_disposition       SET SCHEMA gif;
        ALTER TYPE tool_status              SET SCHEMA gif;

        -- audit_events partitions first (must match parent schema)
        ALTER TABLE audit_events_2026_03 SET SCHEMA gif;
        ALTER TABLE audit_events_2026_04 SET SCHEMA gif;
        ALTER TABLE audit_events_2026_05 SET SCHEMA gif;
        ALTER TABLE audit_events_2026_06 SET SCHEMA gif;

        -- Partitioned parent
        ALTER TABLE audit_events             SET SCHEMA gif;

        -- GIF core tables
        ALTER TABLE personas                 SET SCHEMA gif;
        ALTER TABLE sessions                 SET SCHEMA gif;
        ALTER TABLE scope_violations         SET SCHEMA gif;
        ALTER TABLE delegation_chain         SET SCHEMA gif;
        ALTER TABLE revocation_log           SET SCHEMA gif;
        ALTER TABLE user_persona_assignments SET SCHEMA gif;
        ALTER TABLE erasure_log              SET SCHEMA gif;
        ALTER TABLE entities                 SET SCHEMA gif;
        ALTER TABLE relationships            SET SCHEMA gif;
        ALTER TABLE tool_registry            SET SCHEMA gif;
    ELSE
        RAISE NOTICE 'Fresh install: tables already in gif schema — skipping SET SCHEMA operations';
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- PART 5: gif_app grants on gif schema
--
-- Runtime grants for the GIF enforcement engine application user.
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
-- PART 6: Verify
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    gif_table_count INTEGER;
    gif_type_count  INTEGER;
BEGIN
    SELECT count(*) INTO gif_table_count
    FROM information_schema.tables
    WHERE table_schema = 'gif' AND table_type = 'BASE TABLE';

    SELECT count(*) INTO gif_type_count
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'gif' AND t.typtype = 'e';

    -- At least 10 gif tables at this point (partitions count as BASE TABLE)
    IF gif_table_count < 10 THEN
        RAISE EXCEPTION 'Expected at least 10 tables in gif schema, found %', gif_table_count;
    END IF;

    IF gif_type_count <> 5 THEN
        RAISE EXCEPTION 'Expected 5 enum types in gif schema, found %', gif_type_count;
    END IF;

    RAISE NOTICE 'Migration 005 verified: % gif tables, % gif enum types', gif_table_count, gif_type_count;
END;
$$;

COMMIT;
