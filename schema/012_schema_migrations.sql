-- Migration 012: introduce schema_migrations tracking table
-- Enables safe incremental upgrades without wiping existing data.
-- After this migration, init-db.sh applies each migration exactly once,
-- recording it here on success.

CREATE TABLE IF NOT EXISTS gif.schema_migrations (
    migration_name TEXT        NOT NULL,
    applied_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT schema_migrations_pkey PRIMARY KEY (migration_name)
);

COMMENT ON TABLE gif.schema_migrations IS
    'Records which SQL migrations have been applied to this database. '
    'Managed by init-db.sh — do not modify manually.';

GRANT SELECT, INSERT ON gif.schema_migrations TO gif_app;
