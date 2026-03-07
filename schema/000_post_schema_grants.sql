-- =============================================================================
-- Post-Schema Grants
-- Applies to: gif_research database
-- Run as: psql -U postgres -d gif_research -f gif/schema/000_post_schema_grants.sql
-- Prerequisite: 001_gif_core.sql and research/schema/001_research_pipeline.sql deployed.
--
-- Grants minimum required permissions to gif_app application user.
-- Audit tables receive INSERT-only grants here.
-- Full INSERT-only RLS enforcement on audit_events added in Sprint 3.
-- =============================================================================

-- Schema usage
GRANT USAGE ON SCHEMA public TO gif_app;

-- Read/write on all current and future tables
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO gif_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gif_app;

-- Ensure future tables created by superuser are also accessible
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE ON TABLES TO gif_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO gif_app;

-- ---------------------------------------------------------------------------
-- AUDIT TABLE RESTRICTIONS
-- Revoke UPDATE on append-only tables.
-- gif_app may INSERT but not UPDATE or DELETE audit records.
-- Note: Full RLS policy (INSERT only) enforced in Sprint 3.
-- This is a belt-and-suspenders grant restriction in the interim.
-- ---------------------------------------------------------------------------

REVOKE UPDATE ON audit_events FROM gif_app;
REVOKE UPDATE ON scope_violations FROM gif_app;
REVOKE UPDATE ON revocation_log FROM gif_app;
REVOKE UPDATE ON delegation_chain FROM gif_app;

-- No DELETE permitted on any table for the application user
REVOKE DELETE ON ALL TABLES IN SCHEMA public FROM gif_app;

-- Confirm grants (run this manually to verify)
-- \dp audit_events
-- \dp scope_violations
