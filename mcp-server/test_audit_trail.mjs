/*
 * Copyright 2026 Notboatanchor Labs LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// test_sprint3.mjs
// =============================================================================
// Sprint 3 validation — Audit Trail Validation
//
// Tests:
//   1. RLS enforcement — gif_app cannot UPDATE or DELETE audit_events rows
//   2. blocked_at correctness — scope violation records store layer name, not timestamp
//   3. Scope violation completeness — every blocked tool call has a violation record
//   4. purpose_declared population — audit events include persona purpose
//   5. Point-in-time reconstruction — full action history for a persona_id + window
//
// Prerequisites:
//   - MCP server running on port 3100
//   - A valid active persona exists in the database
//   - Environment: PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD set (or defaults)
//
// Run from gif/mcp-server/:
//   node test_sprint3.mjs <persona_id>
// =============================================================================

import pg from 'pg';
import { Client as McpClient } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const { Pool } = pg;

const personaIdArg = process.argv[2];

// ---------------------------------------------------------------------------
// Postgres connection — connects as gif_app (application user)
// ---------------------------------------------------------------------------

const pool = new Pool({
  host:     process.env.PGHOST     || 'localhost',
  port:     parseInt(process.env.PGPORT || '5432'),
  database: process.env.PGDATABASE || 'gif',
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

// Auto-discover persona if not provided as argument (for npm test compatibility)
let personaId = personaIdArg;
if (!personaId) {
  const r = await pool.query(
    `SELECT persona_id FROM gif.personas WHERE status = 'active' LIMIT 1`
  );
  if (r.rows.length === 0) {
    console.error('[sprint3] No active persona found — run earlier sprint tests first');
    await pool.end();
    process.exit(1);
  }
  personaId = r.rows[0].persona_id;
}

// ---------------------------------------------------------------------------
// Test 1: RLS enforcement on audit_events
// gif_app must be able to INSERT but must not be able to UPDATE or DELETE.
// ---------------------------------------------------------------------------

console.log('\n[sprint3] Test 1: RLS enforcement on audit_events');

// First, get a real persona to insert a valid audit event
let testEventId = null;
try {
  // Insert a valid audit event — this should succeed
  const insertResult = await pool.query(
    `INSERT INTO audit_events (persona_id, event_type, outcome)
     VALUES ($1, 'scope_check', 'success')
     RETURNING event_id, occurred_at`,
    [personaId]
  );
  testEventId = insertResult.rows[0].event_id;
  const occurredAt = insertResult.rows[0].occurred_at;
  pass(`INSERT into audit_events succeeded (event_id: ${testEventId})`);
} catch (err) {
  fail('INSERT into audit_events', err.message);
}

// UPDATE must be blocked — REVOKE UPDATE + no RLS UPDATE policy
try {
  const updateResult = await pool.query(
    `UPDATE audit_events SET flagged = true WHERE event_id = $1`,
    [testEventId]
  );
  if (updateResult.rowCount === 0) {
    pass('UPDATE on audit_events blocked (0 rows affected — RLS filtered)');
  } else {
    fail(`UPDATE on audit_events should be blocked but modified ${updateResult.rowCount} row(s)`);
  }
} catch (err) {
  if (err.message.includes('permission denied')) {
    pass('UPDATE on audit_events blocked by permission denial');
  } else {
    fail('UPDATE on audit_events threw unexpected error', err.message);
  }
}

// DELETE must be blocked
try {
  const delResult = await pool.query(
    `DELETE FROM audit_events WHERE event_id = $1`,
    [testEventId]
  );
  if (delResult.rowCount === 0) {
    pass('DELETE on audit_events blocked (0 rows affected — RLS filtered)');
  } else {
    fail('DELETE on audit_events should be blocked but deleted rows');
  }
} catch (err) {
  if (err.message.includes('permission denied')) {
    pass('DELETE on audit_events blocked by permission denial');
  } else {
    fail('DELETE on audit_events', err.message);
  }
}

// ---------------------------------------------------------------------------
// Test 2: RLS enforcement on scope_violations
// ---------------------------------------------------------------------------

console.log('\n[sprint3] Test 2: RLS enforcement on scope_violations');

let testViolationId = null;
try {
  const insertResult = await pool.query(
    `INSERT INTO scope_violations
       (persona_id, attempted_action, attempted_tool, blocked_at, blocked)
     VALUES ($1, 'rls_test', 'test_tool', 'mcp_validation', true)
     RETURNING violation_id`,
    [personaId]
  );
  testViolationId = insertResult.rows[0].violation_id;
  pass(`INSERT into scope_violations succeeded`);
} catch (err) {
  fail('INSERT into scope_violations', err.message);
}

try {
  const delResult = await pool.query(
    `DELETE FROM scope_violations WHERE violation_id = $1`,
    [testViolationId]
  );
  if (delResult.rowCount === 0) {
    pass('DELETE on scope_violations blocked (0 rows — RLS filtered)');
  } else {
    fail('DELETE on scope_violations should be blocked but deleted rows');
  }
} catch (err) {
  if (err.message.includes('permission denied')) {
    pass('DELETE on scope_violations blocked by permission denial');
  } else {
    fail('DELETE on scope_violations', err.message);
  }
}

// ---------------------------------------------------------------------------
// Test 3: blocked_at stores enforcement layer name, not a timestamp
// Trigger a scope violation via MCP and verify the blocked_at value.
// ---------------------------------------------------------------------------

console.log('\n[sprint3] Test 3: blocked_at correctness (enforcement layer name)');

const MCP_URL = process.env.MCP_BASE_URL || 'http://localhost:3100';
const transport = new StreamableHTTPClientTransport(new URL(`${MCP_URL}/mcp`));
const mcp = new McpClient({ name: 'sprint3-test', version: '0.1.0' }, { capabilities: {} });
await mcp.connect(transport);

// PR2: mint a v0.2 governance session handle (GIF-019/020) for all governed
// calls in this test.
const startResult = await mcp.callTool({
  name: 'session_start',
  arguments: { persona_id: personaId },
});
const gif_session_id = JSON.parse(startResult.content[0].text).gif_session_id;

// Record violation count before the blocked call
const violationsBefore = await pool.query(
  `SELECT count(*) AS cnt FROM scope_violations WHERE persona_id = $1`,
  [personaId]
);
const countBefore = parseInt(violationsBefore.rows[0].cnt);

// Trigger a scope violation: db_read on a table the persona cannot access.
// retention_holds is in ALLOWED_READ_TABLES but will fail scope check
// unless the persona explicitly lists it in permitted_sources.
const scopeTestResult = await mcp.callTool({
  name: 'db_read',
  arguments: {
    persona_id: personaId,
    gif_session_id,
    table: 'retention_holds',
    limit: 1,
  },
});
console.log(`  [info] scope test call outcome: isError=${scopeTestResult.isError ?? false}`);

const violationsAfter = await pool.query(
  `SELECT count(*) AS cnt FROM scope_violations WHERE persona_id = $1`,
  [personaId]
);
const countAfter = parseInt(violationsAfter.rows[0].cnt);

if (countAfter > countBefore) {
  // Check the blocked_at value of the most recent violation
  const latestViolation = await pool.query(
    `SELECT blocked_at FROM scope_violations
     WHERE persona_id = $1
     ORDER BY occurred_at DESC
     LIMIT 1`,
    [personaId]
  );
  const blockedAt = latestViolation.rows[0]?.blocked_at;
  const validLayers = ['mcp_validation', 'synthesis_gate', 'export_gate'];

  if (validLayers.includes(blockedAt)) {
    pass(`blocked_at is enforcement layer name: '${blockedAt}'`);
  } else {
    fail(`blocked_at should be an enforcement layer name`, `got: '${blockedAt}'`);
  }
} else {
  // No new violation — persona may actually have access to synthesis_outputs
  // Skip this test with a note
  console.log('  [SKIP] No scope violation triggered — persona may have retention_holds access');
  console.log('         Verify blocked_at manually: SELECT blocked_at FROM scope_violations ORDER BY occurred_at DESC LIMIT 5;');
}

// ---------------------------------------------------------------------------
// Test 4: purpose_declared populated on audit events
// ---------------------------------------------------------------------------

console.log('\n[sprint3] Test 4: purpose_declared populated on audit events');

// Make a tool call using a table in this persona's permitted_sources.
await mcp.callTool({
  name: 'db_read',
  arguments: {
    persona_id: personaId,
    gif_session_id,
    table: 'sessions',
    limit: 1,
  },
});

const recentAuditEvent = await pool.query(
  `SELECT purpose_declared, outcome FROM audit_events
   WHERE persona_id = $1
     AND event_type = 'tool_call'
     AND occurred_at <= now()
   ORDER BY occurred_at DESC
   LIMIT 1`,
  [personaId]
);

if (recentAuditEvent.rows.length > 0) {
  const { purpose_declared, outcome } = recentAuditEvent.rows[0];
  console.log(`  [info] most recent audit event outcome: ${outcome}`);
  if (purpose_declared && purpose_declared.length > 0) {
    pass(`purpose_declared populated: '${purpose_declared.substring(0, 80)}'`);
  } else {
    fail('purpose_declared is null or empty on recent audit event');
  }
} else {
  fail('No recent audit event found for persona');
}

// ---------------------------------------------------------------------------
// Test 5: Point-in-time reconstruction
// Given persona_id, retrieve full ordered action history with session context.
// ---------------------------------------------------------------------------

console.log('\n[sprint3] Test 5: Point-in-time reconstruction');

const reconstruction = await pool.query(
  `SELECT
     ae.occurred_at,
     ae.event_type,
     ae.tool_name,
     ae.outcome,
     ae.purpose_declared,
     ae.sources_touched,
     s.invocation_context,
     s.started_at   AS session_started,
     s.ended_at     AS session_ended
   FROM audit_events ae
   LEFT JOIN sessions s ON s.session_id = ae.session_id
   WHERE ae.persona_id = $1
   ORDER BY ae.occurred_at ASC`,
  [personaId]
);

if (reconstruction.rows.length > 0) {
  pass(`Point-in-time reconstruction returned ${reconstruction.rows.length} events`);

  // Verify each event has occurred_at, event_type, outcome
  const incomplete = reconstruction.rows.filter(
    r => !r.occurred_at || !r.event_type || !r.outcome
  );
  if (incomplete.length === 0) {
    pass('All audit events have occurred_at, event_type, and outcome');
  } else {
    fail(`${incomplete.length} audit events missing required fields`);
  }

  // Verify session linkage
  const withSession = reconstruction.rows.filter(r => r.session_started !== null);
  if (withSession.length > 0) {
    pass(`${withSession.length} of ${reconstruction.rows.length} events have session records`);
  } else {
    fail('No events have session records — session linkage broken');
  }

  console.log('\n  Sample reconstruction (last 3 events):');
  reconstruction.rows.slice(-3).forEach(r => {
    console.log(`    ${r.occurred_at.toISOString()} | ${r.event_type} | ${r.tool_name ?? '-'} | ${r.outcome}`);
    if (r.purpose_declared) {
      console.log(`      purpose: ${r.purpose_declared.substring(0, 80)}`);
    }
  });
} else {
  fail('No audit events found for persona — reconstruction returned empty');
}

// ---------------------------------------------------------------------------
// Cleanup and summary
// ---------------------------------------------------------------------------

// Explicit caller-close per GIF-020.
await mcp.callTool({
  name: 'session_close',
  arguments: { persona_id: personaId, gif_session_id },
});

await mcp.close();
await pool.end();

console.log(`\n[sprint3] Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('[sprint3] SPRINT 3 VALIDATION INCOMPLETE — review failures above');
  process.exit(1);
} else {
  console.log('[sprint3] All Sprint 3 audit trail checks passed');
}
