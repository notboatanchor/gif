// test_persona_lifecycle.mjs
// =============================================================================
// Sprint 3 — Persona lifecycle audit event validation
//
// Tests:
//   1. persona_create via MCP produces audit_event with event_type='persona_create'
//      and source_ref = new persona_id
//   2. persona_revoke via MCP produces audit_event with event_type='persona_revoke'
//      and source_ref = target persona_id
//   3. persona_create is rejected when issuer lacks manage_personas
//   4. revocation_log entry exists for the revoked persona
//
// Prerequisites:
//   - MCP server running on port 3100
//   - An active persona with 'manage_personas' in permitted_actions
//   - Environment: PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD set (or defaults)
//
// Run from gif/mcp-server/:
//   node test_persona_lifecycle.mjs <admin_persona_id> <unprivileged_persona_id>
// =============================================================================

import pg from 'pg';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const { Pool } = pg;

const adminPersonaId = process.argv[2];
const unprivPersonaId = process.argv[3];

if (!adminPersonaId || !unprivPersonaId) {
  console.error('[lifecycle] Usage: node test_persona_lifecycle.mjs <admin_persona_id> <unprivileged_persona_id>');
  process.exit(1);
}

const pool = new Pool({
  host:     process.env.PGHOST     || 'localhost',
  port:     parseInt(process.env.PGPORT || '5432'),
  database: process.env.PGDATABASE || 'gif_research',
  user:     process.env.PGUSER     || 'gif_app',
  password: process.env.PGPASSWORD,
});

let passed = 0;
let failed = 0;

function pass(label) {
  console.log(`  [PASS] ${label}`);
  passed++;
}

function fail(label, detail) {
  console.error(`  [FAIL] ${label}${detail ? ': ' + detail : ''}`);
  failed++;
}

const transport = new SSEClientTransport(new URL('http://localhost:3100/sse'));
const mcp = new McpClient({ name: 'lifecycle-test', version: '0.1.0' }, { capabilities: {} });
await mcp.connect(transport);

// ---------------------------------------------------------------------------
// Test 1: persona_create produces audit event with event_type='persona_create'
// ---------------------------------------------------------------------------

console.log('\n[lifecycle] Test 1: persona_create audit event');

const validUntil = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

const createResult = await mcp.callTool({
  name: 'persona_create',
  arguments: {
    persona_id:       adminPersonaId,
    issuing_entity:   'lifecycle-test',
    purpose:          'Sprint 3 lifecycle audit test persona — created via MCP tool',
    created_by:       'test_persona_lifecycle.mjs',
    scope_definition: JSON.stringify({
      permitted_sources: ['entities'],
      permitted_actions: ['read'],
    }),
    valid_until: validUntil,
  },
});

console.log(`  [info] persona_create isError=${createResult.isError ?? false}`);

let createdPersonaId = null;

if (!createResult.isError) {
  try {
    const parsed = JSON.parse(createResult.content[0].text);
    createdPersonaId = parsed.persona_id;
    pass(`persona_create succeeded — new persona_id: ${createdPersonaId}`);
  } catch (e) {
    fail('persona_create response parse error', e.message);
  }
} else {
  fail('persona_create call failed', createResult.content[0]?.text);
}

// Check audit event
if (createdPersonaId) {
  // Brief wait for async audit write
  await new Promise(r => setTimeout(r, 300));

  const auditRow = await pool.query(
    `SELECT event_type, tool_name, outcome, source_ref, purpose_declared
     FROM audit_events
     WHERE persona_id = $1
       AND event_type = 'persona_create'
     ORDER BY occurred_at DESC
     LIMIT 1`,
    [adminPersonaId]
  );

  if (auditRow.rows.length > 0) {
    const row = auditRow.rows[0];
    if (row.event_type === 'persona_create') {
      pass(`audit_event event_type='persona_create'`);
    } else {
      fail('audit_event event_type wrong', row.event_type);
    }
    if (row.source_ref === createdPersonaId) {
      pass(`audit_event source_ref = new persona_id (${row.source_ref})`);
    } else {
      fail('audit_event source_ref wrong', `expected ${createdPersonaId}, got ${row.source_ref}`);
    }
    if (row.purpose_declared) {
      pass(`audit_event purpose_declared populated`);
    } else {
      fail('audit_event purpose_declared is null');
    }
  } else {
    fail('No persona_create audit event found for admin persona');
  }
}

// ---------------------------------------------------------------------------
// Test 2: persona_revoke produces audit event with event_type='persona_revoke'
// ---------------------------------------------------------------------------

console.log('\n[lifecycle] Test 2: persona_revoke audit event');

if (!createdPersonaId) {
  console.log('  [SKIP] No persona created in Test 1 — skipping revoke test');
} else {
  const revokeResult = await mcp.callTool({
    name: 'persona_revoke',
    arguments: {
      persona_id:        adminPersonaId,
      target_persona_id: createdPersonaId,
      reason:            'Sprint 3 lifecycle test — revoke after create',
      revoked_by:        'test_persona_lifecycle.mjs',
    },
  });

  console.log(`  [info] persona_revoke isError=${revokeResult.isError ?? false}`);

  if (!revokeResult.isError) {
    pass('persona_revoke call succeeded');
  } else {
    fail('persona_revoke call failed', revokeResult.content[0]?.text);
  }

  await new Promise(r => setTimeout(r, 300));

  const revokeAudit = await pool.query(
    `SELECT event_type, tool_name, outcome, source_ref
     FROM audit_events
     WHERE persona_id = $1
       AND event_type = 'persona_revoke'
     ORDER BY occurred_at DESC
     LIMIT 1`,
    [adminPersonaId]
  );

  if (revokeAudit.rows.length > 0) {
    const row = revokeAudit.rows[0];
    if (row.event_type === 'persona_revoke') {
      pass(`audit_event event_type='persona_revoke'`);
    } else {
      fail('audit_event event_type wrong', row.event_type);
    }
    if (row.source_ref === createdPersonaId) {
      pass(`audit_event source_ref = target persona_id (${row.source_ref})`);
    } else {
      fail('audit_event source_ref wrong', `expected ${createdPersonaId}, got ${row.source_ref}`);
    }
  } else {
    fail('No persona_revoke audit event found for admin persona');
  }

  // Check revocation_log
  const revLog = await pool.query(
    `SELECT previous_status, new_status, reason, revoked_by
     FROM revocation_log
     WHERE persona_id = $1
     ORDER BY revoked_at DESC
     LIMIT 1`,
    [createdPersonaId]
  );

  if (revLog.rows.length > 0) {
    const row = revLog.rows[0];
    if (row.new_status === 'revoked') {
      pass(`revocation_log entry exists — new_status='revoked'`);
    } else {
      fail('revocation_log new_status wrong', row.new_status);
    }
  } else {
    fail('No revocation_log entry for revoked persona');
  }
}

// ---------------------------------------------------------------------------
// Test 3: persona_create rejected without manage_personas
// ---------------------------------------------------------------------------

console.log('\n[lifecycle] Test 3: persona_create rejected without manage_personas');

const unprivCreate = await mcp.callTool({
  name: 'persona_create',
  arguments: {
    persona_id:       unprivPersonaId,
    issuing_entity:   'test',
    purpose:          'Should be rejected',
    created_by:       'test',
    scope_definition: JSON.stringify({ permitted_sources: [], permitted_actions: [] }),
    valid_until:      validUntil,
  },
});

if (unprivCreate.isError) {
  pass('persona_create correctly rejected for unprivileged persona');
  // Verify scope violation recorded
  await new Promise(r => setTimeout(r, 300));
  const violation = await pool.query(
    `SELECT attempted_action, blocked_at
     FROM scope_violations
     WHERE persona_id = $1
       AND attempted_tool = 'persona_create'
     ORDER BY occurred_at DESC
     LIMIT 1`,
    [unprivPersonaId]
  );
  if (violation.rows.length > 0) {
    pass(`scope_violation recorded — blocked_at='${violation.rows[0].blocked_at}'`);
  } else {
    fail('No scope_violation recorded for rejected persona_create');
  }
} else {
  fail('persona_create should have been rejected for unprivileged persona');
}

// ---------------------------------------------------------------------------

await mcp.close();
await pool.end();

console.log(`\n[lifecycle] Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('[lifecycle] PERSONA LIFECYCLE VALIDATION INCOMPLETE');
  process.exit(1);
} else {
  console.log('[lifecycle] All persona lifecycle audit checks passed');
}
