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

// test_session_dispatch.mjs
// =============================================================================
// Dispatcher session-handle rejection tests (GIF-020, GIF-022 C2.x).
//
// Validates the v0.2 dispatcher's session-handle check between persona
// validation and tool execution. Each rejection path is exercised against
// the db_read governed tool and the audit-event emission is verified
// directly against gif.audit_events.
//
// Cases covered:
//   1. Governed call without gif_session_id  → MCP InvalidParams (no audit)
//   2. Unknown handle                        → SESSION_NOT_FOUND + audit
//                                              (session_rejected_closed,
//                                               session_id NULL)
//   3. Persona-mismatched handle             → SESSION_PERSONA_MISMATCH +
//                                              audit (session_id = the handle)
//   4. Caller-closed handle                  → SESSION_CLOSED + audit
//   5. TTL-expired handle (started_at moved  → SESSION_EXPIRED + audit
//      backwards via admin pool)               (session_expired event type)
//   6. Closure precedence (closed AND        → SESSION_CLOSED (closure wins
//      expired)                                over expiry per GIF-020)
//   7. Successful governed call does NOT     → sessions.ended_at IS NULL
//      auto-close the session                  after the call returns
//
// Requires: MCP server running on port 3100, test_setup.mjs run first.
// Run from gif/mcp-server/:
//   npm run build && node test_session_dispatch.mjs
// =============================================================================

import pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Admin pool for verification + started_at manipulation
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
// Discover two approved personas with db_read scope
// ---------------------------------------------------------------------------

console.log('\n[session-dispatch] Dispatcher session-handle rejection tests\n');

const personasResult = await adminPool.query(
  `SELECT persona_id FROM gif.personas
    WHERE status = 'active'
      AND governance_review_status = 'approved'
      AND scope_definition->'permitted_actions' ? 'read'
      AND scope_definition->'permitted_sources' ? 'tool_registry'
    ORDER BY created_at
    LIMIT 2`
);
if (personasResult.rows.length < 2) {
  console.error('[session-dispatch] Need 2 approved personas with read+tool_registry scope — run test_setup.mjs first');
  await adminPool.end();
  process.exit(1);
}
const personaA = personasResult.rows[0].persona_id;
const personaB = personasResult.rows[1].persona_id;
console.log(`[session-dispatch] personaA=${personaA}, personaB=${personaB}\n`);

// ---------------------------------------------------------------------------
// Connect to MCP server
// ---------------------------------------------------------------------------

const MCP_URL = process.env.MCP_BASE_URL || 'http://localhost:3100';
const transport = new StreamableHTTPClientTransport(new URL(`${MCP_URL}/mcp`));
const client = new Client({ name: 'test-session-dispatch', version: '0.1.0' }, { capabilities: {} });
await client.connect(transport);

async function startSession(personaId) {
  const r = await client.callTool({
    name: 'session_start',
    arguments: { persona_id: personaId },
  });
  return parseToolResult(r).gif_session_id;
}

async function dbRead(personaId, gifSessionId) {
  return client.callTool({
    name: 'db_read',
    arguments: {
      persona_id:     personaId,
      gif_session_id: gifSessionId,
      table:          'tool_registry',
      limit:          1,
    },
  });
}

// ---------------------------------------------------------------------------
// Test 1: Governed call without gif_session_id → MCP InvalidParams
// ---------------------------------------------------------------------------

{
  let threw = false;
  let errMsg = '';
  try {
    await client.callTool({
      name: 'db_read',
      arguments: {
        persona_id: personaA,
        table:      'tool_registry',
        limit:      1,
      },
    });
  } catch (err) {
    threw = true;
    errMsg = err?.message ?? String(err);
  }
  if (threw && /gif_session_id/.test(errMsg)) {
    pass('governed call without gif_session_id throws MCP error');
  } else {
    fail('governed call without gif_session_id should throw with gif_session_id mention',
         `threw=${threw}, msg=${errMsg}`);
  }
}

// ---------------------------------------------------------------------------
// Test 2: Unknown handle → SESSION_NOT_FOUND
// ---------------------------------------------------------------------------

{
  const unknown = '00000000-0000-0000-0000-000000000000';
  const result = await dbRead(personaA, unknown);
  const parsed = parseToolResult(result);

  if (result.isError === true && parsed.reason === 'SESSION_NOT_FOUND') {
    pass('unknown handle rejected with SESSION_NOT_FOUND');
  } else {
    fail('unknown handle should reject with SESSION_NOT_FOUND', JSON.stringify(parsed));
  }

  // Audit event: session_rejected_closed, source_ref=SESSION_NOT_FOUND, session_id NULL
  const audit = await adminPool.query(
    `SELECT count(*)::int AS cnt FROM gif.audit_events
      WHERE event_type = 'session_rejected_closed'
        AND source_ref = 'SESSION_NOT_FOUND'
        AND tool_name  = 'db_read'
        AND persona_id = $1
        AND session_id IS NULL`,
    [personaA]
  );
  if (audit.rows[0].cnt >= 1) {
    pass('SESSION_NOT_FOUND rejection emits audit (session_rejected_closed, session_id NULL)');
  } else {
    fail('SESSION_NOT_FOUND audit missing', `count=${audit.rows[0].cnt}`);
  }
}

// ---------------------------------------------------------------------------
// Test 3: Persona-mismatched handle → SESSION_PERSONA_MISMATCH
// ---------------------------------------------------------------------------

{
  const ownerHandle = await startSession(personaA);
  // Call as personaB using personaA's handle
  const result = await dbRead(personaB, ownerHandle);
  const parsed = parseToolResult(result);

  if (result.isError === true && parsed.reason === 'SESSION_PERSONA_MISMATCH') {
    pass('persona-mismatched handle rejected with SESSION_PERSONA_MISMATCH');
  } else {
    fail('persona-mismatched handle should reject with SESSION_PERSONA_MISMATCH',
         JSON.stringify(parsed));
  }

  const audit = await adminPool.query(
    `SELECT count(*)::int AS cnt FROM gif.audit_events
      WHERE event_type = 'session_rejected_closed'
        AND source_ref = 'SESSION_PERSONA_MISMATCH'
        AND tool_name  = 'db_read'
        AND persona_id = $1
        AND session_id = $2`,
    [personaB, ownerHandle]
  );
  if (audit.rows[0].cnt >= 1) {
    pass('SESSION_PERSONA_MISMATCH rejection emits audit linked to the handle');
  } else {
    fail('SESSION_PERSONA_MISMATCH audit missing', `count=${audit.rows[0].cnt}`);
  }
}

// ---------------------------------------------------------------------------
// Test 4: Caller-closed handle → SESSION_CLOSED
// ---------------------------------------------------------------------------

let closedHandle;
{
  closedHandle = await startSession(personaA);
  // Close via the session_close tool
  await client.callTool({
    name: 'session_close',
    arguments: { persona_id: personaA, gif_session_id: closedHandle },
  });

  const result = await dbRead(personaA, closedHandle);
  const parsed = parseToolResult(result);

  if (result.isError === true && parsed.reason === 'SESSION_CLOSED') {
    pass('caller-closed handle rejected with SESSION_CLOSED');
  } else {
    fail('closed handle should reject with SESSION_CLOSED', JSON.stringify(parsed));
  }

  const audit = await adminPool.query(
    `SELECT count(*)::int AS cnt FROM gif.audit_events
      WHERE event_type = 'session_rejected_closed'
        AND source_ref = 'SESSION_CLOSED'
        AND tool_name  = 'db_read'
        AND persona_id = $1
        AND session_id = $2`,
    [personaA, closedHandle]
  );
  if (audit.rows[0].cnt >= 1) {
    pass('SESSION_CLOSED rejection emits audit linked to the handle');
  } else {
    fail('SESSION_CLOSED audit missing', `count=${audit.rows[0].cnt}`);
  }
}

// ---------------------------------------------------------------------------
// Test 5: TTL-expired handle → SESSION_EXPIRED
// Default TTL is 86400 (24h). Move started_at to 25h ago via admin pool.
// ---------------------------------------------------------------------------

{
  const expiredHandle = await startSession(personaA);
  await adminPool.query(
    `UPDATE gif.sessions
        SET started_at = now() - interval '25 hours'
      WHERE session_id = $1`,
    [expiredHandle]
  );

  const result = await dbRead(personaA, expiredHandle);
  const parsed = parseToolResult(result);

  if (result.isError === true && parsed.reason === 'SESSION_EXPIRED') {
    pass('TTL-expired handle rejected with SESSION_EXPIRED');
  } else {
    fail('expired handle should reject with SESSION_EXPIRED', JSON.stringify(parsed));
  }

  // Audit event: session_expired (distinct event type, not session_rejected_closed)
  const audit = await adminPool.query(
    `SELECT count(*)::int AS cnt FROM gif.audit_events
      WHERE event_type = 'session_expired'
        AND source_ref = 'SESSION_EXPIRED'
        AND tool_name  = 'db_read'
        AND persona_id = $1
        AND session_id = $2`,
    [personaA, expiredHandle]
  );
  if (audit.rows[0].cnt >= 1) {
    pass('SESSION_EXPIRED rejection emits audit (session_expired event type)');
  } else {
    fail('SESSION_EXPIRED audit missing', `count=${audit.rows[0].cnt}`);
  }
}

// ---------------------------------------------------------------------------
// Test 6: Closure precedence — closed AND expired both true → SESSION_CLOSED wins
// (GIF-020 §Closure precedence: closed > expired.)
// Reuse the closedHandle from Test 4: it was closed at T0; push started_at back
// 25h so it would also be expired. SESSION_CLOSED must still win.
// ---------------------------------------------------------------------------

{
  await adminPool.query(
    `UPDATE gif.sessions
        SET started_at = now() - interval '25 hours'
      WHERE session_id = $1`,
    [closedHandle]
  );

  const result = await dbRead(personaA, closedHandle);
  const parsed = parseToolResult(result);

  if (result.isError === true && parsed.reason === 'SESSION_CLOSED') {
    pass('closed-and-expired handle resolves to SESSION_CLOSED (closure precedence)');
  } else {
    fail('closure precedence violated: closed+expired should resolve as SESSION_CLOSED',
         JSON.stringify(parsed));
  }
}

// ---------------------------------------------------------------------------
// Test 7: Successful governed call does NOT auto-close the session
// (GIF-020: dispatcher no longer closes; closure is caller-driven or TTL-driven.)
// ---------------------------------------------------------------------------

{
  const activeHandle = await startSession(personaA);
  const result = await dbRead(personaA, activeHandle);
  if (result.isError) {
    fail('successful-path setup: db_read returned error', JSON.stringify(parseToolResult(result)));
  } else {
    pass('successful-path db_read returned non-error');
  }

  const sessionRow = await adminPool.query(
    `SELECT ended_at FROM gif.sessions WHERE session_id = $1`,
    [activeHandle]
  );
  if (sessionRow.rows.length === 1 && sessionRow.rows[0].ended_at === null) {
    pass('session is NOT auto-closed by dispatcher after successful governed call');
  } else {
    fail('session was auto-closed after governed call', JSON.stringify(sessionRow.rows[0]));
  }

  // Cleanup: caller-close the active session
  await client.callTool({
    name: 'session_close',
    arguments: { persona_id: personaA, gif_session_id: activeHandle },
  });
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

await client.close();
await adminPool.end();

console.log(`\n[session-dispatch] ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
