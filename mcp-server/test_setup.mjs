// test_setup.mjs
// =============================================================================
// Test fixture setup — creates seed personas for the integration test suite.
//
// Runs as gif_admin (direct SQL) to bypass the HMAC identity token requirement.
// This is intentional for testing: the HMAC flow is validated separately in
// test_sprint5_identity_binding.mjs.
//
// Creates:
//   1. A basic active persona with read+write scope (used by sprint3, sprint4)
//   2. A persona with audit_events read scope (used by sprint5 read log test)
//
// Idempotent: checks if personas already exist before inserting.
// =============================================================================

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  host:     process.env.PGHOST          || 'localhost',
  port:     parseInt(process.env.PGPORT || '5432'),
  user:     process.env.PGADMINUSER     || 'gif_admin',
  password: process.env.PGADMINPASSWORD,
  database: process.env.PGDATABASE      || 'gif',
});

try {
  const existing = await pool.query(
    `SELECT count(*) AS cnt FROM gif.personas WHERE status = 'active'`
  );

  if (parseInt(existing.rows[0].cnt) > 0) {
    console.log('[setup] Active personas already exist — skipping seed');
    process.exit(0);
  }

  // Persona 1: admin test persona (manage_personas + read + write scope, delegation depth 3)
  await pool.query(`
    INSERT INTO gif.personas
      (issuing_entity, purpose, created_by, scope_definition, valid_until, status, max_delegation_depth, governance_review_status)
    VALUES (
      'test-setup',
      'Integration test persona — sprint 3/4 validation',
      'test_setup',
      '{
        "permitted_actions": ["read", "write", "manage_personas"],
        "permitted_sources": ["audit_events", "sessions", "scope_violations", "tool_registry", "delegation_chain", "revocation_log"],
        "output_destinations": ["user_persona_assignments"],
        "max_results": 100
      }'::jsonb,
      now() + interval '30 days',
      'active',
      3,
      'approved'
    )
  `);

  // Persona 2: audit reader persona (for sprint5 read log tests)
  await pool.query(`
    INSERT INTO gif.personas
      (issuing_entity, purpose, created_by, scope_definition, valid_until, status, governance_review_status)
    VALUES (
      'test-setup',
      'Audit read test persona — sprint 5 read log validation',
      'test_setup',
      '{
        "permitted_actions": ["read"],
        "permitted_sources": ["audit_events", "tool_registry"],
        "max_results": 50
      }'::jsonb,
      now() + interval '30 days',
      'active',
      'approved'
    )
  `);

  console.log('[setup] Seed personas created');
} catch (err) {
  console.error('[setup] Error:', err.message);
  process.exit(1);
} finally {
  await pool.end();
}
