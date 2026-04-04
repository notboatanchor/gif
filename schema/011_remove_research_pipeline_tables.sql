-- =============================================================================
-- GIF Schema — Migration 011
-- Remove Research Pipeline holdover tables and tool registry entries.
--
-- Run as: gif_admin (via gif/scripts/install.sh or init-db.sh)
--
-- What this migration does:
--   1. Drops gif.relationships (FK dependency on entities — must drop first)
--   2. Drops gif.entities
--   3. Removes source_score and graph_query from tool_registry
--      (adopter-layer tools registered by gif-stack, not gif framework tools)
--
-- Background:
--   entities and relationships were seeded in 001_gif_core.sql as graph-ready
--   shared tables for FederalGraph and Research Pipeline verticals. Those
--   verticals have been extracted to gif-stack. gif is the enforcement engine
--   only; vertical-specific schema lives in adopter repos.
--
--   source_score (domain credibility scoring) and graph_query (Neo4j traversal)
--   are Research Pipeline and FederalGraph tools respectively. They have no
--   role in the gif enforcement engine.
--
-- ADR-033: gif repository separation from gif-stack
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Drop Research Pipeline / FederalGraph tables
-- relationships depends on entities — drop in dependency order.
-- CASCADE covers indexes and constraints.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS gif.relationships CASCADE;
DROP TABLE IF EXISTS gif.entities CASCADE;

-- ---------------------------------------------------------------------------
-- Remove adopter-layer tool registry entries
-- source_score and graph_query were seeded in 001_gif_core.sql for
-- Research Pipeline and FederalGraph adopters. They are not gif framework
-- tools and do not belong in this repo's registry.
-- ---------------------------------------------------------------------------

DELETE FROM gif.tool_registry
WHERE tool_name IN ('source_score', 'graph_query');

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    entities_exists      BOOLEAN;
    relationships_exists BOOLEAN;
    total_tool_count     INTEGER;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'gif' AND table_name = 'entities'
    ) INTO entities_exists;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'gif' AND table_name = 'relationships'
    ) INTO relationships_exists;

    SELECT count(*) INTO total_tool_count FROM gif.tool_registry;

    IF entities_exists THEN
        RAISE EXCEPTION 'entities table still exists after migration 011';
    END IF;

    IF relationships_exists THEN
        RAISE EXCEPTION 'relationships table still exists after migration 011';
    END IF;

    IF total_tool_count <> 5 THEN
        RAISE EXCEPTION 'Expected 5 tools in tool_registry after removing source_score and graph_query, found %', total_tool_count;
    END IF;

    RAISE NOTICE 'Migration 011 verified: entities and relationships dropped, tool_registry has % tools', total_tool_count;
END;
$$;

COMMIT;
