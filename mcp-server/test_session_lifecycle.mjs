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

// test_session_lifecycle.mjs
// =============================================================================
// session_start / session_close lifecycle tests (GIF-019, GIF-020).
//
// Exercises the two new v0.2 governance-session MCP tools end-to-end through
// the MCP Streamable HTTP transport. PR1 scope: the two new tools and their
// audit-event emission. The dispatcher closed/expired check, gif_session_id
// required arg on governed tools, and combination-accumulation tests land in
// PR2 alongside the dispatcher refactor.
//
// Cases covered:
//   1. session_start mints a UUID handle and emits a session_start audit event
//   2. session_close on an owned active session sets ended_at, emits
//      session_close audit event, returns { closed: true }
//   3. Double-close: second session_close on the same handle is rejected
//      with SESSION_ALREADY_CLOSED + emits a session_rejected_closed event
//   4. Persona-mismatch close: persona_id != session's owner is rejected
//      with SESSION_PERSONA_MISMATCH + emits a session_rejected_closed event
//   5. Unknown handle close: gif_session_id has no row is rejected with
//      SESSION_NOT_FOUND + emits a session_rejected_closed event (session_id
//      null)
//
// Requires: MCP server running on port 3100, test_setup.mjs run first.
// Run from gif/mcp-server/:
//   npm run build && node test_session_lifecycle.mjs
// =============================================================================

import pg from 'pg';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Pools — admin for direct verification queries, app for parity with prod
// ---------------------------------------------------------------------------

const adminPool = new Pool({
  host:     process.env.PGHOST          || 'localhost',
  port:     parseInt(process.env.PGPORT || '5432'),
  user:     process.env.PGADMINUSER     || 'gif_admin',
  password: process.env.PGADMINPASSWORD,
  database: process.env.PGDATABASE      || 'gif',
});

// ---------------------------------------------------------------------------
// Pass/fail bookkeeping
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function pass(label) { console.log(`  [PASS] ${label}`); passed++; }
function fail(label, detail) {
  console.error(`  [FAIL] ${label}${detail ? ': ' + detail : ''}`);
  failed++;
}

function parseToolResult(result) {
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// Discover two approved personas — one as session owner, one as bystander
// for the persona-mismatch case
// ---------------------------------------------------------------------------

console.log('\n[session-lifecycle] session_start / session_close tests\n');

const personasResult = await adminPool.query(
  `SELECT persona_id FROM gif.personas
    WHERE status = 'active' AND governance_review_status = 'approved'
    ORDER BY created_at
    LIMIT 2`
);
if (personasResult.rows.length < 2) {
  console.error('[session-lifecycle] Need at least 2 approved personas — run test_setup.mjs first');
  await adminPool.end();
  process.exit(1);
}
const ownerPersonaId    = personasResult.rows[0].persona_id;
const bystanderPersonaId = personasResult.rows[1].persona_id;
console.log(`[session-lifecycle] owner=${ownerPersonaId}, bystander=${bystanderPersonaId}\n`);

// ---------------------------------------------------------------------------
// Connect to MCP server
// ---------------------------------------------------------------------------

const MCP_URL = process.env.MCP_BASE_URL || 'http://localhost:3100';
const transport = new StreamableHTTPClientTransport(new URL(`${MCP_URL}/mcp`));
const client = new Client({ name: 'test-session-lifecycle', version: '0.1.0' }, { capabilities: {} });
await client.connect(transport);

// ---------------------------------------------------------------------------
// Test 1: session_start mints a handle and emits session_start audit event
// ---------------------------------------------------------------------------

let sessionHandle;
{
  const result = await client.callTool({
    name: 'session_start',
    arguments: {
      persona_id:         ownerPersonaId,
      invocation_context: { test: 'session_lifecycle', case: 'mint' },
    },
  });
  const parsed = parseToolResult(result);

  if (!parsed.gif_session_id || typeof parsed.gif_session_id !== 'string') {
    fail('session_start returns gif_session_id string', JSON.stringify(parsed));
  } else {
    sessionHandle = parsed.gif_session_id;
    pass(`session_start mints a handle (${sessionHandle.slice(0, 8)}...)`);
  }

  // Verify session row exists, owned by ownerPersonaId, ended_at IS NULL
  const sessionRow = await adminPool.query(
    `SELECT persona_id, ended_at, invocation_context
       FROM gif.sessions WHERE session_id = $1`,
    [sessionHandle]
  );
  if (sessionRow.rows.length !== 1) {
    fail('session row created', `expected 1 row, got ${sessionRow.rows.length}`);
  } else if (sessionRow.rows[0].persona_id !== ownerPersonaId) {
    fail('session row owned by ownerPersonaId',
         `expected ${ownerPersonaId}, got ${sessionRow.rows[0].persona_id}`);
  } else if (sessionRow.rows[0].ended_at !== null) {
    fail('session row starts with ended_at NULL', `got ${sessionRow.rows[0].ended_at}`);
  } else {
    pass('session row created, owned, active');
  }

  // Verify session_start audit event exists
  const auditRow = await adminPool.query(
    `SELECT event_type, outcome FROM gif.audit_events
      WHERE session_id = $1 AND event_type = 'session_start'`,
    [sessionHandle]
  );
  if (auditRow.rows.length !== 1) {
    fail('exactly one session_start audit event (C1.5)',
         `expected 1, got ${auditRow.rows.length}`);
  } else if (auditRow.rows[0].outcome !== 'success') {
    fail('session_start audit event outcome=success',
         `got ${auditRow.rows[0].outcome}`);
  } else {
    pass('session_start audit event emitted (C1.5)');
  }
}

// ---------------------------------------------------------------------------
// Test 2: session_close on owned active session succeeds
// ---------------------------------------------------------------------------

{
  const result = await client.callTool({
    name: 'session_close',
    arguments: { persona_id: ownerPersonaId, gif_session_id: sessionHandle },
  });
  const parsed = parseToolResult(result);

  if (parsed.closed !== true) {
    fail('session_close returns closed: true', JSON.stringify(parsed));
  } else {
    pass('session_close on owned active session returns closed: true');
  }

  // Verify ended_at set
  const sessionRow = await adminPool.query(
    `SELECT ended_at FROM gif.sessions WHERE session_id = $1`,
    [sessionHandle]
  );
  if (sessionRow.rows[0].ended_at === null) {
    fail('session_close sets ended_at (C3.4)', 'ended_at is still NULL');
  } else {
    pass('session_close sets sessions.ended_at (C3.4)');
  }

  // Verify session_close audit event emitted
  const auditRow = await adminPool.query(
    `SELECT outcome FROM gif.audit_events
      WHERE session_id = $1 AND event_type = 'session_close'`,
    [sessionHandle]
  );
  if (auditRow.rows.length !== 1) {
    fail('exactly one session_close audit event (C3.4)',
         `expected 1, got ${auditRow.rows.length}`);
  } else if (auditRow.rows[0].outcome !== 'success') {
    fail('session_close audit event outcome=success',
         `got ${auditRow.rows[0].outcome}`);
  } else {
    pass('session_close audit event emitted (C3.4)');
  }
}

// ---------------------------------------------------------------------------
// Test 3: Double-close — rejected as SESSION_ALREADY_CLOSED + emits
// session_rejected_closed audit event
// ---------------------------------------------------------------------------

{
  const result = await client.callTool({
    name: 'session_close',
    arguments: { persona_id: ownerPersonaId, gif_session_id: sessionHandle },
  });
  const parsed = parseToolResult(result);

  if (result.isError !== true || parsed.closed !== false ||
      parsed.error !== 'SESSION_ALREADY_CLOSED') {
    fail('double-close rejects with SESSION_ALREADY_CLOSED', JSON.stringify(parsed));
  } else {
    pass('double-close rejected with SESSION_ALREADY_CLOSED (C3.5)');
  }

  const rejectionAudit = await adminPool.query(
    `SELECT count(*)::int AS cnt FROM gif.audit_events
      WHERE session_id = $1 AND event_type = 'session_rejected_closed'
        AND source_ref = 'SESSION_ALREADY_CLOSED'`,
    [sessionHandle]
  );
  if (rejectionAudit.rows[0].cnt < 1) {
    fail('double-close emits session_rejected_closed audit (C3.5, C2.7)',
         `count=${rejectionAudit.rows[0].cnt}`);
  } else {
    pass('double-close emits session_rejected_closed audit (C3.5, C2.7)');
  }
}

// ---------------------------------------------------------------------------
// Test 4: Persona-mismatch close — bystander tries to close owner's session
// ---------------------------------------------------------------------------

let mismatchHandle;
{
  // Mint a fresh active session for the owner
  const mint = await client.callTool({
    name: 'session_start',
    arguments: { persona_id: ownerPersonaId, invocation_context: { case: 'mismatch' } },
  });
  mismatchHandle = parseToolResult(mint).gif_session_id;

  const result = await client.callTool({
    name: 'session_close',
    arguments: { persona_id: bystanderPersonaId, gif_session_id: mismatchHandle },
  });
  const parsed = parseToolResult(result);

  if (result.isError !== true || parsed.error !== 'SESSION_PERSONA_MISMATCH') {
    fail('bystander close rejects with SESSION_PERSONA_MISMATCH', JSON.stringify(parsed));
  } else {
    pass('persona-mismatch close rejected with SESSION_PERSONA_MISMATCH (C2.7)');
  }

  const rejectionAudit = await adminPool.query(
    `SELECT count(*)::int AS cnt FROM gif.audit_events
      WHERE session_id = $1 AND event_type = 'session_rejected_closed'
        AND source_ref = 'SESSION_PERSONA_MISMATCH'`,
    [mismatchHandle]
  );
  if (rejectionAudit.rows[0].cnt < 1) {
    fail('persona-mismatch emits session_rejected_closed audit (C2.7)',
         `count=${rejectionAudit.rows[0].cnt}`);
  } else {
    pass('persona-mismatch emits session_rejected_closed audit (C2.7)');
  }

  // Verify the session was NOT closed by the failed attempt
  const sessionRow = await adminPool.query(
    `SELECT ended_at FROM gif.sessions WHERE session_id = $1`,
    [mismatchHandle]
  );
  if (sessionRow.rows[0].ended_at !== null) {
    fail('rejected close did not mutate ended_at', 'ended_at was set');
  } else {
    pass('rejected close did not mutate ended_at (C3.3)');
  }
}

// ---------------------------------------------------------------------------
// Test 5: Unknown-handle close — gif_session_id has no row
// ---------------------------------------------------------------------------

{
  const unknownHandle = '00000000-0000-0000-0000-000000000000';
  const result = await client.callTool({
    name: 'session_close',
    arguments: { persona_id: ownerPersonaId, gif_session_id: unknownHandle },
  });
  const parsed = parseToolResult(result);

  if (result.isError !== true || parsed.error !== 'SESSION_NOT_FOUND') {
    fail('unknown-handle close rejects with SESSION_NOT_FOUND', JSON.stringify(parsed));
  } else {
    pass('unknown-handle close rejected with SESSION_NOT_FOUND (C2.7)');
  }

  // Audit event has session_id NULL since the row does not exist
  const rejectionAudit = await adminPool.query(
    `SELECT count(*)::int AS cnt FROM gif.audit_events
      WHERE event_type = 'session_rejected_closed'
        AND source_ref = 'SESSION_NOT_FOUND'
        AND persona_id = $1
        AND session_id IS NULL`,
    [ownerPersonaId]
  );
  if (rejectionAudit.rows[0].cnt < 1) {
    fail('unknown-handle emits session_rejected_closed audit with session_id NULL (C2.7)',
         `count=${rejectionAudit.rows[0].cnt}`);
  } else {
    pass('unknown-handle emits session_rejected_closed audit, session_id NULL (C2.7)');
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

await client.close();
await adminPool.end();

console.log(`\n[session-lifecycle] ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
