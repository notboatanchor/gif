-- =============================================================================
-- GIF Schema — Bootstrap
-- Run as: psql -U <superuser> -d gif -f gif/schema/000_bootstrap.sql
--
-- This is the ONLY script that requires superuser access.
-- All subsequent migrations (001 through latest) run as gif_admin.
--
-- Prerequisites (Docker):
--   POSTGRES_DB=gif in .env — Docker creates the gif database automatically.
--   Run this script in the gif database as the Docker superuser.
--
-- Prerequisites (bare metal / managed service):
--   CREATE DATABASE gif;  (or pass the target database name via psql -d)
--   Then run this script as the Postgres superuser / CREATEROLE-privileged user.
--
-- What this script does:
--   1. Creates gif_admin and gif_app roles (no passwords — set by install script)
--   2. Transfers gif database ownership to gif_admin
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
-- Adopter layers (Research Pipeline, FederalGraph) run their own bootstrap
-- scripts that create their application roles and schemas, then grant access
-- to gif schema tables as needed.
--
-- ADR-028: Database schema separation and account model
-- ADR-032: GIF ownership model and deployment topology
-- =============================================================================

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
-- Database ownership
--
-- gif_admin owns the database so it can create schemas and manage DDL
-- without requiring superuser for subsequent operations.
-- ---------------------------------------------------------------------------

DO $$ BEGIN
    EXECUTE format('ALTER DATABASE %I OWNER TO gif_admin', current_database());
END $$;

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
