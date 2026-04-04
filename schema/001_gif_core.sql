-- =============================================================================
-- GIF Core Schema — Migration 001
-- Applies to: gif_research database
-- Run as: psql -U postgres -d gif_research -f gif/schema/001_gif_core.sql
--
-- Covers:
--   personas            Persona registry and scope definitions
--   sessions            Session grouping for audit events (ADR-017)
--   audit_events        Append-only action log
--   scope_violations    Out-of-scope attempt records
--   delegation_chain    Persona inheritance records
--   revocation_log      Persona state change history
--   tool_registry       Available MCP tools and default constraints
--   entities            Named entities shared across all verticals (graph-ready)
--   relationships       Entity-to-entity relationships (graph-ready)
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- ENUMS
-- ---------------------------------------------------------------------------

CREATE TYPE persona_status AS ENUM (
    'active',
    'suspended',
    'revoked',
    'expired'
);

-- Governance review gate — currently auto-approves all personas (ADR-017)
CREATE TYPE governance_review_status AS ENUM (
    'auto_approved',
    'pending',
    'approved'
);

-- Data classification tiers — dormant until classification is implemented (ADR-017)
CREATE TYPE data_classification_tier AS ENUM (
    'public',
    'internal',
    'confidential',
    'restricted'
);

-- Output disposition — what happened to synthesis output after generation (ADR-017)
CREATE TYPE output_disposition AS ENUM (
    'retained',
    'exported',
    'discarded'
);

CREATE TYPE tool_status AS ENUM (
    'active',
    'planned',
    'deferred',
    'deprecated'
);

-- ---------------------------------------------------------------------------
-- PERSONAS
-- Scope boundary record for every AI instantiation.
-- Created before any AI action occurs. All actions reference persona_id.
-- ---------------------------------------------------------------------------

CREATE TABLE personas (
    persona_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Who issued this persona and for what declared purpose
    issuing_entity          VARCHAR(255) NOT NULL,
    purpose                 VARCHAR(1000) NOT NULL,  -- required, not nullable (ADR-017)
    created_by              VARCHAR(255) NOT NULL,

    -- Operational scope contract — enforced at MCP layer (ADR-008)
    scope_definition        JSONB NOT NULL,
    -- scope_definition structure:
    --   permitted_sources:          string[]   — SearXNG, postgres table names, etc.
    --   permitted_actions:          string[]   — read | write | synthesize | export | delegate
    --   synthesis_depth:            integer    — max inference hops from source data
    --   output_destinations:        string[]   — postgres tables, file paths, endpoints
    --   retention_policy:           string     — how long artifacts are retained

    -- Temporal bounds — no open-ended scope
    valid_from              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    valid_until             TIMESTAMP WITH TIME ZONE NOT NULL,

    -- Persona hierarchy — explicit inheritance chain
    parent_persona_id       UUID REFERENCES personas(persona_id),
    max_delegation_depth    INTEGER NOT NULL DEFAULT 0,

    -- Status — revocation is immediate
    status                  persona_status NOT NULL DEFAULT 'active',

    -- Governance stub fields (ADR-017) — attachment points, not yet enforced
    data_classification_ceiling     data_classification_tier,       -- max tier this persona may synthesize across
    combination_policy_ref          UUID,                           -- deferred FK to combination_policies (table not yet created)
    governance_review_status        governance_review_status NOT NULL DEFAULT 'auto_approved',

    -- Audit timestamps
    created_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

COMMENT ON TABLE personas IS
    'Scope boundary registry. Every AI action must reference an active persona. '
    'Personas define what the AI is permitted to know, do, and remember.';

COMMENT ON COLUMN personas.purpose IS
    'Required. Human-readable declaration of business function. '
    'Machine-evaluable by a future governance layer. Non-nullable by design (ADR-017).';

COMMENT ON COLUMN personas.scope_definition IS
    'JSONB operational contract enforced at MCP layer. '
    'Keys: permitted_sources, permitted_actions, synthesis_depth, output_destinations, retention_policy.';

COMMENT ON COLUMN personas.combination_policy_ref IS
    'Deferred FK to combination_policies table (not yet created). '
    'Attachment point for cross-dataset synthesis authorization rules (ADR-017).';

COMMENT ON COLUMN personas.governance_review_status IS
    'Structural slot for future governance gate at persona issuance. '
    'Currently auto-approves all personas. Gate logic inserted here without workflow redesign (ADR-017).';

-- ---------------------------------------------------------------------------
-- SESSIONS
-- Groups all audit events within a single pipeline invocation.
-- Introduced to support session_id on audit_events (ADR-017).
-- ---------------------------------------------------------------------------

CREATE TABLE sessions (
    session_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    persona_id              UUID NOT NULL REFERENCES personas(persona_id),

    started_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    ended_at                TIMESTAMP WITH TIME ZONE,               -- null while session is active

    -- Runtime context at session start — supports point-in-time reconstruction
    invocation_context      JSONB
    -- invocation_context structure (when populated):
    --   pipeline_phase:   string    — pass1 | evaluation | pass2 | synthesis
    --   topic:            string    — research topic for this session
    --   configuration_id: uuid      — research_configurations reference (research schema)
    --   triggered_by:     string    — manual | scheduled | event
);

COMMENT ON TABLE sessions IS
    'Groups audit events within a single pipeline invocation. '
    'Enables session-level behavioral analysis and duration baselines (ADR-017).';

COMMENT ON COLUMN sessions.ended_at IS
    'Null while session is active. Set on graceful close or revocation.';

COMMENT ON COLUMN sessions.invocation_context IS
    'Runtime context snapshot at session start. Supports point-in-time reconstruction '
    'independent of current configuration state.';

-- ---------------------------------------------------------------------------
-- AUDIT EVENTS
-- Append-only. No UPDATE or DELETE permitted for application user.
-- Row-level security enforced in Sprint 3 — INSERT-only RLS policy added then.
-- Timestamps from database server clock, not application layer.
-- ---------------------------------------------------------------------------

CREATE TABLE audit_events (
    event_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Persona and session lineage — every event traceable to its authorization
    persona_id              UUID NOT NULL REFERENCES personas(persona_id),
    session_id              UUID REFERENCES sessions(session_id),   -- groups events within one invocation (ADR-017)
    invoked_by_persona_id   UUID REFERENCES personas(persona_id),   -- parent persona when delegation in play (ADR-017)

    -- Event classification
    event_type              VARCHAR(100) NOT NULL,
    -- expected values: tool_call | synthesis | export | persona_create |
    --                  persona_revoke | scope_check | human_review

    -- What was touched and what happened
    tool_name               VARCHAR(100),                           -- MCP tool name if event_type = tool_call
    source_ref              TEXT,                                   -- URL, table name, or resource identifier
    outcome                 VARCHAR(50) NOT NULL,                   -- success | rejected | error
    flagged                 BOOLEAN NOT NULL DEFAULT false,         -- true if event warrants review

    -- Governance stub fields (ADR-017) — populated by MCP layer and export gate
    sources_touched         JSONB,                                  -- actual data sources accessed this event
    purpose_declared        TEXT,                                   -- copied from persona.purpose at session start
    sensitivity_encountered data_classification_tier,               -- classification level actually present in data accessed
    output_disposition      output_disposition,                     -- what happened to output (populated at export)
    human_actor_id          UUID,                                   -- human reviewer/approver UUID if human action (ADR-017)

    -- Server-side timestamp — not settable by application
    occurred_at             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

COMMENT ON TABLE audit_events IS
    'Append-only log of every AI action. No UPDATE or DELETE for application user. '
    'INSERT-only RLS enforced in Sprint 3. Timestamps from server clock.';

COMMENT ON COLUMN audit_events.session_id IS
    'Groups all events within one pipeline invocation. Enables session-level '
    'behavioral analysis and anomaly detection (ADR-017).';

COMMENT ON COLUMN audit_events.invoked_by_persona_id IS
    'The persona that triggered this action when delegation is in play. '
    'Distinct from persona_id (the authorized scope). Enables child persona '
    'behavioral analysis relative to parent design intent (ADR-017).';

COMMENT ON COLUMN audit_events.sources_touched IS
    'JSONB array of data sources actually accessed during this event. '
    'Populated by MCP tool layer. Required for output lineage (ADR-017).';

COMMENT ON COLUMN audit_events.human_actor_id IS
    'Non-null only on human review, approval, or override events. '
    'Absence is auditable — AI-only actions are distinguishable from human-reviewed actions (ADR-017).';

-- ---------------------------------------------------------------------------
-- SCOPE VIOLATIONS
-- Created for every out-of-scope attempt, whether blocked or not.
-- Absence of records is itself auditable.
-- ---------------------------------------------------------------------------

CREATE TABLE scope_violations (
    violation_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    persona_id              UUID NOT NULL REFERENCES personas(persona_id),
    session_id              UUID REFERENCES sessions(session_id),

    -- What was attempted and where it was blocked
    attempted_action        VARCHAR(255) NOT NULL,
    attempted_tool          VARCHAR(100),
    blocked_at              VARCHAR(100) NOT NULL,                  -- mcp_validation | synthesis_gate | export_gate
    blocked                 BOOLEAN NOT NULL DEFAULT true,          -- false if violation detected post-hoc

    -- Context snapshot at time of violation — for reconstruction
    context_snapshot        JSONB,

    -- Governance stub field (ADR-017)
    available_but_unused    JSONB,
    -- Scope tools/sources within persona scope not invoked this session.
    -- Negative space for evaluating whether scope is appropriately sized.
    -- Populated null until a governance layer computes it from session record.

    occurred_at             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

COMMENT ON TABLE scope_violations IS
    'Every out-of-scope attempt is recorded here, blocked or not. '
    'Absence of records is auditable. MCP layer writes here on rejected tool calls.';

COMMENT ON COLUMN scope_violations.available_but_unused IS
    'Tools and sources within persona scope not invoked this session. '
    'Provides negative space for scope sizing analysis. Null until governance layer computes it (ADR-017).';

-- ---------------------------------------------------------------------------
-- DELEGATION CHAIN
-- Explicit inheritance record for composed or delegated personas.
-- A parent persona cannot grant rights it does not hold.
-- ---------------------------------------------------------------------------

CREATE TABLE delegation_chain (
    delegation_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_persona_id       UUID NOT NULL REFERENCES personas(persona_id),
    child_persona_id        UUID NOT NULL REFERENCES personas(persona_id),

    -- What subset of parent rights were delegated
    delegated_permissions   JSONB NOT NULL,
    delegation_depth        INTEGER NOT NULL,                       -- how many hops from root persona

    delegated_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    delegated_by            VARCHAR(255) NOT NULL
);

COMMENT ON TABLE delegation_chain IS
    'Explicit persona inheritance records. Child persona cannot hold rights '
    'the parent does not have. Enforced at persona creation time.';

-- ---------------------------------------------------------------------------
-- REVOCATION LOG
-- All persona state changes with reason. Revocation is immediate.
-- ---------------------------------------------------------------------------

CREATE TABLE revocation_log (
    revocation_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    persona_id                  UUID NOT NULL REFERENCES personas(persona_id),

    previous_status             persona_status NOT NULL,
    new_status                  persona_status NOT NULL,
    reason                      TEXT NOT NULL,
    revoked_by                  VARCHAR(255) NOT NULL,

    -- Number of sessions terminated by this revocation
    active_sessions_terminated  INTEGER NOT NULL DEFAULT 0,

    revoked_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

COMMENT ON TABLE revocation_log IS
    'All persona state transitions with reason. Revocation is immediate. '
    'active_sessions_terminated records in-flight sessions closed by the revocation.';

-- ---------------------------------------------------------------------------
-- TOOL REGISTRY
-- Available MCP tools, their current status, and default scope constraints.
-- Populated with Phase 1 tools. Sprint 4 fully populates this table.
-- ---------------------------------------------------------------------------

CREATE TABLE tool_registry (
    tool_id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tool_name               VARCHAR(100) NOT NULL UNIQUE,
    description             TEXT NOT NULL,
    status                  tool_status NOT NULL DEFAULT 'planned',

    -- Default scope constraints applied when a persona does not override them
    default_constraints     JSONB,

    -- Which sprint this tool becomes active
    available_from_sprint   INTEGER,

    created_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

COMMENT ON TABLE tool_registry IS
    'MCP tool registry. All tools the model may invoke are registered here. '
    'Scope constraints defined per tool. MCP server reads this at startup.';

-- Seed Phase 1 tools per GIF Technical Spec section 4
INSERT INTO tool_registry (tool_name, description, status, default_constraints, available_from_sprint)
VALUES
    ('db_read',
     'Postgres read. Entity lookup, run history, source registry. Table-level permission per persona scope.',
     'planned',
     '{"require_persona_id": true}',
     2),

    ('db_write',
     'Postgres write. Results, entities, synthesis artifacts. Output targets validated against persona scope.',
     'planned',
     '{"require_persona_id": true, "validate_output_destination": true}',
     2),

    ('source_score',
     'Domain credibility scoring and source classification. Read-only.',
     'planned',
     '{}',
     6),

    ('graph_query',
     'Neo4j entity relationship traversal. Query depth bounded by synthesis_depth in persona scope.',
     'deferred',
     '{"max_hops": 3}',
     11);

-- ---------------------------------------------------------------------------
-- ENTITIES
-- Named entities shared across all verticals.
-- Stable UUIDs — the same contractor entity referenced by FederalGraph and
-- any future vertical uses the same entity_id.
-- Graph-ready: direct SELECT loads into Neo4j (ADR-006).
-- ---------------------------------------------------------------------------

CREATE TABLE entities (
    entity_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Entity classification
    entity_type             VARCHAR(100) NOT NULL,
    -- expected values (GIF core, vertical-agnostic):
    --   organization | person | agency | location | concept
    -- FederalGraph extends with: contractor | lobbying_firm | lobbyist |
    --   elected_official | committee | pac | donor

    canonical_name          VARCHAR(500) NOT NULL,
    aliases                 JSONB,                                  -- array of known alternate names

    -- Source provenance
    first_seen_source       TEXT,                                   -- URL or dataset name where entity was first identified
    first_seen_run_id       UUID,                                   -- research run that first surfaced this entity

    -- Confidence in this entity record
    confidence_score        NUMERIC(4,3) CHECK (confidence_score BETWEEN 0 AND 1),

    -- Persona lineage — which persona created this entity record
    created_by_persona_id   UUID NOT NULL REFERENCES personas(persona_id),

    created_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

COMMENT ON TABLE entities IS
    'Named entities shared across all verticals. Stable UUID identifiers. '
    'Graph-ready: Neo4j load is a direct SELECT with no transformation required (ADR-006).';

COMMENT ON COLUMN entities.entity_type IS
    'GIF core types: organization | person | agency | location | concept. '
    'Vertical schemas extend with domain-specific types via their own tables.';

COMMENT ON COLUMN entities.aliases IS
    'JSONB array of known alternate names, abbreviations, and variants. '
    'Used by entity resolution logic to link records across datasets.';

-- ---------------------------------------------------------------------------
-- RELATIONSHIPS
-- Entity-to-entity relationships. Explicit records with type, confidence,
-- and source attribution. Graph-ready: Neo4j load is a direct SELECT (ADR-006).
-- ---------------------------------------------------------------------------

CREATE TABLE relationships (
    relationship_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The two entities in this relationship
    source_entity_id        UUID NOT NULL REFERENCES entities(entity_id),
    target_entity_id        UUID NOT NULL REFERENCES entities(entity_id),

    -- Relationship classification
    relationship_type       VARCHAR(100) NOT NULL,
    -- GIF core types are vertical-agnostic.
    -- FederalGraph adds: AWARDED_TO | LOBBIED_FOR | CONTRIBUTED_TO |
    --   SITS_ON | FORMERLY_HELD | SUBSIDIARY_OF | RESOLVES_TO etc.

    -- Confidence and provenance — no inference stored as fact
    confidence_score        NUMERIC(4,3) NOT NULL CHECK (confidence_score BETWEEN 0 AND 1),
    resolution_method       VARCHAR(100),                           -- name_match | uuid_match | probabilistic | human_reviewed
    source_attribution      JSONB,                                  -- source URLs or dataset references supporting this relationship

    -- Temporal validity — relationships can have known start/end dates
    valid_from              TIMESTAMP WITH TIME ZONE,
    valid_until             TIMESTAMP WITH TIME ZONE,

    -- Persona lineage
    created_by_persona_id   UUID NOT NULL REFERENCES personas(persona_id),

    created_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

COMMENT ON TABLE relationships IS
    'Entity-to-entity relationships with source attribution and confidence scores. '
    'No inference stored as fact — confidence_score distinguishes resolved from inferred. '
    'Graph-ready: Neo4j load is a direct SELECT from entities and relationships (ADR-006).';

COMMENT ON COLUMN relationships.confidence_score IS
    'Required. Values: 1.0 = confirmed, 0.7-0.99 = high confidence, '
    '0.4-0.69 = probable, <0.4 = speculative. Never null — ambiguous matches '
    'go to human review queue rather than being silently resolved.';

COMMENT ON COLUMN relationships.source_attribution IS
    'JSONB array of source references supporting this relationship assertion. '
    'Every relationship is traceable to originating public records.';

-- ---------------------------------------------------------------------------
-- INDEXES
-- ---------------------------------------------------------------------------

-- personas: status lookups for active persona validation
CREATE INDEX idx_personas_status ON personas(status);
CREATE INDEX idx_personas_issuing_entity ON personas(issuing_entity);
CREATE INDEX idx_personas_valid_until ON personas(valid_until);

-- sessions: persona lookups
CREATE INDEX idx_sessions_persona_id ON sessions(persona_id);
CREATE INDEX idx_sessions_started_at ON sessions(started_at);

-- audit_events: high-frequency lookup paths
CREATE INDEX idx_audit_events_persona_id ON audit_events(persona_id);
CREATE INDEX idx_audit_events_session_id ON audit_events(session_id);
CREATE INDEX idx_audit_events_occurred_at ON audit_events(occurred_at);
CREATE INDEX idx_audit_events_event_type ON audit_events(event_type);
CREATE INDEX idx_audit_events_flagged ON audit_events(flagged) WHERE flagged = true;

-- scope_violations: persona and session lookups
CREATE INDEX idx_scope_violations_persona_id ON scope_violations(persona_id);
CREATE INDEX idx_scope_violations_session_id ON scope_violations(session_id);

-- entities: canonical name and type lookups for entity resolution
CREATE INDEX idx_entities_entity_type ON entities(entity_type);
CREATE INDEX idx_entities_canonical_name ON entities(canonical_name);

-- relationships: graph traversal paths — both directions
CREATE INDEX idx_relationships_source_entity ON relationships(source_entity_id);
CREATE INDEX idx_relationships_target_entity ON relationships(target_entity_id);
CREATE INDEX idx_relationships_type ON relationships(relationship_type);

COMMIT;
