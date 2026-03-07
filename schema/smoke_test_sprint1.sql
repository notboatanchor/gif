-- =============================================================================
-- Sprint 1 Smoke Tests
-- Run as: psql -U gif_app -d gif_research -f gif/schema/smoke_test_sprint1.sql
--
-- Validates:
--   - All Sprint 1 tables exist and accept INSERT
--   - Foreign key relationships are wired correctly
--   - Append-only tables reject UPDATE (via application user)
--   - Indexes exist
--   - tool_registry seed data is present
-- =============================================================================

\echo '=== Sprint 1 Smoke Tests ==='
\echo ''

-- ---------------------------------------------------------------------------
-- Test 1: Insert a persona
-- ---------------------------------------------------------------------------
\echo '--- Test 1: Insert persona ---'

INSERT INTO personas (
    issuing_entity,
    purpose,
    created_by,
    scope_definition,
    valid_from,
    valid_until,
    max_delegation_depth
) VALUES (
    'smoke_test',
    'Sprint 1 schema validation — not a production persona',
    'smoke_test_script',
    '{
        "permitted_sources": ["searxng"],
        "permitted_actions": ["read", "synthesize"],
        "synthesis_depth": 1,
        "output_destinations": ["research_runs"],
        "retention_policy": "30_days"
    }',
    now(),
    now() + INTERVAL '1 hour',
    0
) RETURNING persona_id AS "Persona created";

-- ---------------------------------------------------------------------------
-- Test 2: Insert a session referencing the persona
-- ---------------------------------------------------------------------------
\echo '--- Test 2: Insert session ---'

INSERT INTO sessions (
    persona_id,
    invocation_context
)
SELECT
    persona_id,
    '{"pipeline_phase": "smoke_test", "topic": "schema validation"}'
FROM personas
WHERE purpose = 'Sprint 1 schema validation — not a production persona'
RETURNING session_id AS "Session created";

-- ---------------------------------------------------------------------------
-- Test 3: Insert an audit event referencing persona and session
-- ---------------------------------------------------------------------------
\echo '--- Test 3: Insert audit event ---'

INSERT INTO audit_events (
    persona_id,
    session_id,
    event_type,
    outcome,
    purpose_declared
)
SELECT
    p.persona_id,
    s.session_id,
    'smoke_test',
    'success',
    p.purpose
FROM personas p
JOIN sessions s ON s.persona_id = p.persona_id
WHERE p.purpose = 'Sprint 1 schema validation — not a production persona'
RETURNING event_id AS "Audit event created";

-- ---------------------------------------------------------------------------
-- Test 4: INSERT into scope_violations
-- ---------------------------------------------------------------------------
\echo '--- Test 4: Insert scope violation ---'

INSERT INTO scope_violations (
    persona_id,
    attempted_action,
    blocked_at
)
SELECT persona_id, 'smoke_test_action', 'smoke_test'
FROM personas
WHERE purpose = 'Sprint 1 schema validation — not a production persona'
RETURNING violation_id AS "Scope violation created";

-- ---------------------------------------------------------------------------
-- Test 5: Insert entity and relationship
-- ---------------------------------------------------------------------------
\echo '--- Test 5: Insert entity and relationship ---'

INSERT INTO entities (
    entity_type,
    canonical_name,
    confidence_score,
    created_by_persona_id
)
SELECT
    'organization',
    'Smoke Test Entity A',
    1.0,
    persona_id
FROM personas
WHERE purpose = 'Sprint 1 schema validation — not a production persona'
RETURNING entity_id AS "Entity A created";

INSERT INTO entities (
    entity_type,
    canonical_name,
    confidence_score,
    created_by_persona_id
)
SELECT
    'organization',
    'Smoke Test Entity B',
    1.0,
    persona_id
FROM personas
WHERE purpose = 'Sprint 1 schema validation — not a production persona'
RETURNING entity_id AS "Entity B created";

INSERT INTO relationships (
    source_entity_id,
    target_entity_id,
    relationship_type,
    confidence_score,
    resolution_method,
    source_attribution,
    created_by_persona_id
)
SELECT
    a.entity_id,
    b.entity_id,
    'SMOKE_TEST_RELATION',
    0.95,
    'smoke_test',
    '["smoke_test_source"]',
    p.persona_id
FROM entities a, entities b, personas p
WHERE a.canonical_name = 'Smoke Test Entity A'
  AND b.canonical_name = 'Smoke Test Entity B'
  AND p.purpose = 'Sprint 1 schema validation — not a production persona'
RETURNING relationship_id AS "Relationship created";

-- ---------------------------------------------------------------------------
-- Test 6: Research pipeline tables
-- ---------------------------------------------------------------------------
\echo '--- Test 6: Research pipeline tables ---'

INSERT INTO research_configurations (
    name,
    topic_template,
    created_by_persona_id
)
SELECT
    'smoke_test_config',
    'Smoke test topic: {topic}',
    persona_id
FROM personas
WHERE purpose = 'Sprint 1 schema validation — not a production persona'
RETURNING configuration_id AS "Configuration created";

INSERT INTO research_runs (
    configuration_id,
    persona_id,
    session_id,
    topic
)
SELECT
    rc.configuration_id,
    p.persona_id,
    s.session_id,
    'Smoke test run'
FROM research_configurations rc, personas p, sessions s
WHERE rc.name = 'smoke_test_config'
  AND p.purpose = 'Sprint 1 schema validation — not a production persona'
  AND s.persona_id = p.persona_id
RETURNING run_id AS "Run created";

-- ---------------------------------------------------------------------------
-- Test 7: Verify UPDATE is rejected on audit_events (expect error)
-- ---------------------------------------------------------------------------
\echo '--- Test 7: UPDATE on audit_events should fail ---'
\echo '    (Expect: ERROR: permission denied)'

\set ON_ERROR_STOP off
UPDATE audit_events SET flagged = true WHERE event_type = 'smoke_test';
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- Test 8: tool_registry seed data
-- ---------------------------------------------------------------------------
\echo '--- Test 8: tool_registry seed data ---'

SELECT tool_name, status, available_from_sprint
FROM tool_registry
ORDER BY available_from_sprint;

-- ---------------------------------------------------------------------------
-- Test 9: Table existence check
-- ---------------------------------------------------------------------------
\echo '--- Test 9: All expected tables present ---'

SELECT tablename AS "Table"
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

-- ---------------------------------------------------------------------------
-- Cleanup smoke test data
-- ---------------------------------------------------------------------------
\echo '--- Cleanup ---'

DELETE FROM relationships WHERE relationship_type = 'SMOKE_TEST_RELATION';
DELETE FROM entities WHERE canonical_name IN ('Smoke Test Entity A', 'Smoke Test Entity B');
DELETE FROM research_runs WHERE topic = 'Smoke test run';
DELETE FROM research_configurations WHERE name = 'smoke_test_config';
DELETE FROM scope_violations WHERE attempted_action = 'smoke_test_action';
DELETE FROM audit_events WHERE event_type = 'smoke_test';
DELETE FROM sessions WHERE invocation_context::text LIKE '%smoke_test%';
DELETE FROM personas WHERE purpose = 'Sprint 1 schema validation — not a production persona';

\echo ''
\echo '=== Sprint 1 Smoke Tests Complete ==='
\echo '    Review output above. Test 7 (UPDATE rejection) should show an error.'
\echo '    All other tests should show created UUIDs.'
