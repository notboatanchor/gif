-- =============================================================================
-- GIF Stack: Database and Application User Creation
-- Run as: psql -U postgres -f 000_create_db.sql
-- Run once on fresh environment. Idempotent via IF NOT EXISTS guards.
-- =============================================================================

-- Create the database
CREATE DATABASE gif_research;

-- Create the application user with no login privileges beyond what we grant
CREATE USER gif_app WITH ENCRYPTED PASSWORD 'REPLACE_WITH_STRONG_PASSWORD';

-- Connect permission only — table-level grants follow schema deployment
GRANT CONNECT ON DATABASE gif_research TO gif_app;

-- =============================================================================
-- After running this script, connect to gif_research and run:
--   gif/schema/001_gif_core.sql
--   research/schema/001_research_pipeline.sql
-- Then run the post-schema grants in 000_post_schema_grants.sql
-- =============================================================================
