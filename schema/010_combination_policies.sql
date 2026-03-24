-- =============================================================================
-- Migration 010: Combination Policies
-- Activates the combination_policy_ref stub from ADR-017.
-- Run as: gif_admin
--
-- Creates gif.combination_policies — the GIF framework table for aggregation
-- risk enforcement. Adopters (FederalGraph, etc.) register their specific
-- policies as rows; the enforcement engine evaluates them pre-call.
--
-- ADR-022: GIF framework boundary — table structure belongs in GIF
-- ADR-023: Combination policies and aggregation risk — decisions recorded here
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ENUM: enforcement_action
-- What the enforcement engine does when a policy fires.
-- ---------------------------------------------------------------------------

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'enforcement_action'
                   AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'gif')) THEN
        CREATE TYPE gif.enforcement_action AS ENUM (
            'block',                -- Reject the tool call immediately
            'flag',                 -- Allow the call; write flagged audit event
            'require_human_review'  -- Allow only if human_actor_id is present on the session
        );
    END IF;
END $$;

COMMENT ON TYPE gif.enforcement_action IS
    'Enforcement response when a combination policy fires. '
    'block: reject the call. flag: allow with flagged audit record. '
    'require_human_review: allow only when human_actor_id is present (supervised access).';

-- ---------------------------------------------------------------------------
-- Table: combination_policies
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS gif.combination_policies (
    policy_id           UUID                     PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_name         TEXT                     NOT NULL,
    source_set          JSONB                    NOT NULL,
    -- Array of source identifier strings. ALL sources in this set must appear
    -- in the candidate set (session_sources ∪ incoming_sources) to trigger.
    -- Format: ["usaspending", "lda", "fec"]
    -- Matches the format of audit_events.sources_touched.
    sensitivity_result  gif.data_classification_tier NOT NULL,
    -- The sensitivity tier the combination produces.
    enforcement_action  gif.enforcement_action   NOT NULL,
    exempt_persona_ids  UUID[]                   NOT NULL DEFAULT '{}',
    -- Personas explicitly permitted to complete this combination.
    -- Exempt access is allowed but produces a flagged audit event with
    -- sensitivity_encountered set to sensitivity_result.
    -- Populate via direct gif_admin SQL — not via MCP tool.
    active              BOOLEAN                  NOT NULL DEFAULT true,
    -- Operational kill switch. Set false to disable without deleting.
    -- The policy history is preserved; enforcement stops immediately.
    created_by          TEXT                     NOT NULL,
    created_at          TIMESTAMPTZ              NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE gif.combination_policies IS
    'Aggregation risk policies. Defines combinations of data sources that, '
    'when all present in a single session or query, require enforcement action. '
    'Structure owned by GIF; specific policies registered by adopters (ADR-022). '
    'See ADR-023 for design decisions.';

COMMENT ON COLUMN gif.combination_policies.source_set IS
    'JSONB array of source identifier strings. Policy fires when ALL sources '
    'in this set appear in (session sources accumulated so far) + (incoming call sources). '
    'Example: ["usaspending", "lda", "fec"]';

COMMENT ON COLUMN gif.combination_policies.exempt_persona_ids IS
    'UUIDs of personas permitted to complete this combination under governance '
    'controls. Exempt access produces a flagged audit event — it is not silent. '
    'Should only contain admin personas with human_actor_id binding (ADR-021).';

COMMENT ON COLUMN gif.combination_policies.active IS
    'Kill switch. false = policy disabled, enforcement skips it. '
    'Use to temporarily suspend enforcement without deleting the policy.';

-- ---------------------------------------------------------------------------
-- Index: active policy lookups
-- The enforcement engine queries WHERE active = true on every relevant call.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_combination_policies_active
    ON gif.combination_policies (active)
    WHERE active = true;

-- ---------------------------------------------------------------------------
-- FK: personas.combination_policy_ref → combination_policies.policy_id
-- Activates the stub column from ADR-017/migration 001.
-- ---------------------------------------------------------------------------

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_personas_combination_policy_ref'
          AND conrelid = 'gif.personas'::regclass
    ) THEN
        ALTER TABLE gif.personas
            ADD CONSTRAINT fk_personas_combination_policy_ref
            FOREIGN KEY (combination_policy_ref)
            REFERENCES gif.combination_policies (policy_id);
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Grants
-- gif_app: SELECT only — policies are queried by the enforcement engine at
--          runtime but created only by operators (gif_admin).
-- ---------------------------------------------------------------------------

GRANT SELECT ON gif.combination_policies TO gif_app;

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    tbl_exists  BOOLEAN;
    fk_exists   BOOLEAN;
    enum_exists BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'combination_policies' AND n.nspname = 'gif'
    ) INTO tbl_exists;

    SELECT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_personas_combination_policy_ref'
    ) INTO fk_exists;

    SELECT EXISTS (
        SELECT 1 FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE t.typname = 'enforcement_action' AND n.nspname = 'gif'
    ) INTO enum_exists;

    IF NOT tbl_exists  THEN RAISE EXCEPTION 'combination_policies table not created'; END IF;
    IF NOT fk_exists   THEN RAISE EXCEPTION 'personas.combination_policy_ref FK not wired'; END IF;
    IF NOT enum_exists THEN RAISE EXCEPTION 'enforcement_action enum not created'; END IF;

    RAISE NOTICE 'Migration 010 verified: combination_policies ready, FK wired, enforcement_action enum created';
END;
$$;
