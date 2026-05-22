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
-- GIF Schema — Bootstrap
-- Run as: psql -U <superuser> -d <database> -f gif/schema/000_bootstrap.sql
--
-- This is the ONLY script that requires superuser access.
-- All subsequent migrations (001 through latest) run as gif_admin.
--
-- TWO INSTALL PATHS (GIF-016):
--
--   Dedicated database (new database created for GIF):
--     Pass -v gif_dedicated_db=on to transfer database ownership to gif_admin.
--     install.sh does this automatically.
--
--       psql -U postgres -d gif -v gif_dedicated_db=on -f 000_bootstrap.sql
--
--   Existing database (installing GIF alongside other schemas):
--     Omit the flag. Database ownership is not transferred.
--     Prerequisite: the database superuser must first run:
--       GRANT CREATE ON DATABASE <your_database> TO gif_admin;
--
--       psql -U postgres -d <your_database> -f 000_bootstrap.sql
--
-- What this script does:
--   1. Creates gif_admin and gif_app roles (no passwords — set by install script)
--   2. Transfers database ownership to gif_admin (dedicated path only)
--   3. Creates gif schema owned by gif_admin
--   4. Sets search_path for each role
--   5. Grants CONNECT and schema USAGE to gif_app
--
-- Role name design (ADR-032):
--   Role names are fixed framework internals. Adopters who need a custom
--   application user name use RBAC delegation:
--     CREATE ROLE myapp_user WITH LOGIN PASSWORD '...';
--     GRANT gif_app TO myapp_user;
--
-- Adopter layers run their own bootstrap scripts that create their application
-- roles and schemas, then grant access to gif schema tables as needed.
--
-- ADR-028: Database schema separation and account model
-- ADR-032: GIF ownership model and deployment topology
-- GIF-016: Bootstrap install paths
-- =============================================================================

-- Default gif_dedicated_db to off if not passed by the caller.
-- install.sh passes -v gif_dedicated_db=on for the dedicated database path.
\if :{?gif_dedicated_db}
\else
  \set gif_dedicated_db off
\endif

-- ---------------------------------------------------------------------------
-- Roles
--
-- Passwords are NOT set here — the install script sets them immediately after
-- this file runs. No secrets in SQL files.
-- ---------------------------------------------------------------------------

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gif_admin') THEN
        CREATE ROLE gif_admin WITH LOGIN;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gif_app') THEN
        CREATE ROLE gif_app WITH LOGIN;
    END IF;
END $$;

COMMENT ON ROLE gif_admin IS
    'GIF schema owner and migration user. Owns all GIF schema objects. '
    'Used for operator procedures (retire_partition, etc.) and DDL. '
    'Never used at runtime by the application.';

COMMENT ON ROLE gif_app IS
    'GIF enforcement engine application user. Runtime only. '
    'INSERT/SELECT on gif schema tables with append-only enforcement on audit tables. '
    'Adopters who need a custom app user name: GRANT gif_app TO <custom_role>. '
    'Adopter layer users (research_app, etc.) are created by their own bootstrap scripts.';

-- ---------------------------------------------------------------------------
-- Database ownership (dedicated database path only)
--
-- Dedicated path: gif_admin owns the database, giving it schema-creation
-- rights without requiring superuser for subsequent operations.
--
-- Existing database path: skipped. gif_admin owns only the gif schema.
-- Prerequisite: GRANT CREATE ON DATABASE <dbname> TO gif_admin must have
-- been run by the database superuser before executing this script.
-- ---------------------------------------------------------------------------

\if :gif_dedicated_db
DO $$ BEGIN
    EXECUTE format('ALTER DATABASE %I OWNER TO gif_admin', current_database());
    RAISE NOTICE 'Dedicated database path: ownership transferred to gif_admin';
END $$;
\else
DO $$ BEGIN
    RAISE NOTICE 'Existing database path: skipping ownership transfer.';
    RAISE NOTICE 'Prerequisite: gif_admin must have CREATE privilege on this database (GRANT CREATE ON DATABASE ... TO gif_admin).';
END $$;
\endif

-- ---------------------------------------------------------------------------
-- Schemas
--
-- gif schema: GIF core tables, owned by gif_admin.
-- gif_admin search_path includes gif so unqualified DDL in migrations lands
-- in the correct schema.
--
-- Adopter layer schemas (research, federal, etc.) are created by their own
-- bootstrap scripts, not here.
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS gif AUTHORIZATION gif_admin;

COMMENT ON SCHEMA gif IS
    'GIF core tables. Owned by gif_admin. '
    'gif_app has runtime access via explicit grants. '
    'Adopter layer users are granted access by their own bootstrap scripts.';

-- ---------------------------------------------------------------------------
-- Role search paths
-- ---------------------------------------------------------------------------

ALTER ROLE gif_admin SET search_path = gif, public;
ALTER ROLE gif_app   SET search_path = gif;

-- ---------------------------------------------------------------------------
-- Connection and schema access grants
-- ---------------------------------------------------------------------------

DO $$ BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO gif_app', current_database());
END $$;
GRANT USAGE   ON SCHEMA gif   TO gif_app;

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    gif_admin_exists BOOLEAN;
    gif_app_exists   BOOLEAN;
    gif_schema_owner NAME;
BEGIN
    SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'gif_admin') INTO gif_admin_exists;
    SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'gif_app')   INTO gif_app_exists;

    SELECT pg_get_userbyid(nspowner) INTO gif_schema_owner
    FROM pg_namespace WHERE nspname = 'gif';

    IF NOT gif_admin_exists THEN RAISE EXCEPTION 'gif_admin role not created'; END IF;
    IF NOT gif_app_exists   THEN RAISE EXCEPTION 'gif_app role not created';   END IF;
    IF gif_schema_owner <> 'gif_admin' THEN
        RAISE EXCEPTION 'gif schema owner is %, expected gif_admin', gif_schema_owner;
    END IF;

    RAISE NOTICE 'Bootstrap verified: gif_admin and gif_app created, gif schema owned by gif_admin';
END;
$$;
