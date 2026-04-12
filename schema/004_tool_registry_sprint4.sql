-- =============================================================================
-- GIF Schema — Migration 004
-- Tool registry: activate Phase 1 tools, register framework tools,
-- add tool_layer column to distinguish GIF framework tools from adopter tools.
--
-- Applies to: gif schema (database configured via PGDATABASE)
-- Run as: gif_admin (via install.sh — do not run directly)
--
-- Context:
--   tool_registry was seeded in 001_gif_core.sql with Phase 1 adopter tools
--   at status='planned'. Sprint 4 (Integration Hardening) fully populates
--   the registry per ADR-026: framework tools ship with GIF; adopter tools
--   are registered by the adopter implementation layer.
--
-- ADR-026: MCP server deployment topology — framework vs. adopter tool boundary
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Add tool_layer column
-- Distinguishes GIF framework tools from adopter-registered tools.
-- Values:
--   'gif'               — Ships with GIF enforcement engine. Operates on
--                         GIF primitives (personas, sessions). Available to
--                         all adopters.
--   'research_pipeline' — Registered by Research Pipeline implementation.
--   'federal_graph'     — Registered by FederalGraph implementation.
--   'adopter'           — Generic adopter tool (external licensees).
-- NULL is not valid — every registered tool must declare its layer.
-- ---------------------------------------------------------------------------

ALTER TABLE tool_registry
    ADD COLUMN tool_layer VARCHAR(50) NOT NULL DEFAULT 'adopter';

COMMENT ON COLUMN tool_registry.tool_layer IS
    'Which layer owns this tool. gif = ships with GIF enforcement engine and '
    'operates on GIF primitives. Other values reflect the adopter layer that '
    'registered the tool. ADR-026.';

-- ---------------------------------------------------------------------------
-- Activate Phase 1 adopter tools
-- These were seeded as planned in 001_gif_core.sql. They are now validated
-- end-to-end (Sprints 2–3) and are active.
-- tool_layer defaults to adopter — correct for these three.
-- ---------------------------------------------------------------------------

UPDATE tool_registry
SET
    status     = 'active',
    updated_at = now()
WHERE tool_name IN ('db_read', 'db_write');

-- ---------------------------------------------------------------------------
-- Register GIF framework tools
-- These operate on GIF primitives (personas). They ship with the GIF
-- enforcement engine and are available to all adopters.
-- persona_validate does not create a session (diagnostic only).
-- persona_create and persona_revoke are first-class audit events.
-- ---------------------------------------------------------------------------

INSERT INTO tool_registry (
    tool_name,
    description,
    status,
    tool_layer,
    default_constraints,
    available_from_sprint
)
VALUES
    ('persona_validate',
     'Validate a persona by ID. Returns persona details if valid. '
     'Diagnostic tool — does not create a session or audit event.',
     'active',
     'gif',
     '{"creates_session": false}',
     2),

    ('persona_create',
     'Create a new persona in the GIF registry. Issuing persona must have '
     'manage_personas in permitted_actions. Writes to delegation_chain when '
     'parent_persona_id is provided. Audit event type: persona_create.',
     'active',
     'gif',
     '{"required_action": "manage_personas"}',
     3),

    ('persona_revoke',
     'Revoke a persona immediately. Issuing persona must have manage_personas '
     'in permitted_actions. Closes open sessions on the target persona. '
     'Atomic: status update + revocation_log + session close. '
     'Audit event type: persona_revoke.',
     'active',
     'gif',
     '{"required_action": "manage_personas", "closes_active_sessions": true}',
     3);

-- ---------------------------------------------------------------------------
-- Set tool_layer on pre-existing adopter tools explicitly
-- The DEFAULT 'adopter' handles new rows. Existing rows were inserted before
-- the column existed and received the default on ALTER — confirm here.
-- ---------------------------------------------------------------------------

UPDATE tool_registry
SET tool_layer = 'adopter'
WHERE tool_name IN ('db_read', 'db_write', 'source_score', 'graph_query');

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    active_count  INTEGER;
    gif_count     INTEGER;
    planned_count INTEGER;
BEGIN
    SELECT count(*) INTO active_count  FROM tool_registry WHERE status = 'active';
    SELECT count(*) INTO gif_count     FROM tool_registry WHERE tool_layer = 'gif';
    SELECT count(*) INTO planned_count FROM tool_registry WHERE status = 'planned';

    IF active_count <> 5 THEN
        RAISE EXCEPTION 'Expected 5 active tools, found %', active_count;
    END IF;

    IF gif_count <> 3 THEN
        RAISE EXCEPTION 'Expected 3 gif-layer tools, found %', gif_count;
    END IF;

    RAISE NOTICE 'tool_registry: % active tools, % gif-layer tools, % planned',
        active_count, gif_count, planned_count;
END;
$$;

COMMIT;
