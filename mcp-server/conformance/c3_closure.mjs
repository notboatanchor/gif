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

// conformance/c3_closure.mjs
// =============================================================================
// GIF-022 Category 3 — Closure conformance scenarios.
//
// Asserts the C3.1–C3.7 MUSTs in GIF-022 §Conformance-Required Behaviors
// against a running gif MCP server.
//
// Discipline (load-bearing for the conformance contract):
//   - Setup uses the admin pool to discover seeded personas and to backdate
//     sessions.started_at for the TTL cases (C3.6, C3.7). No conformance
//     assertion reads the database via the admin pool.
//   - Every conformance assertion routes through the three MCP surfaces
//     enumerated in GIF-022 §What a Conformance Harness Needs to Introspect:
//     tools/list, tool dispatch, db_read on audit_events.
//   - "read_log" in GIF-022 terminology is db_read(table='audit_events')
//     gated by the admin-read / audit-events read scope.
//   - Case labels carry the MUST IDs (C3.1, C3.2, ...) for direct trace to
//     GIF-022.
//
// Cases:
//   1. C3.1 — session_close is discoverable via tools/list.
//   2. C3.2 — session_close.inputSchema.required includes both persona_id
//      and gif_session_id.
//   3. C3.3 — ownership is validated before any state change: a close
//      attempt by a non-owning persona is rejected with
//      SESSION_PERSONA_MISMATCH, and the session remains usable.
//   4. C3.4 — successful close is a dual-write: ended_at is set (witnessed
//      by SESSION_CLOSED on the next governed call) AND a session_close
//      audit event is emitted.
//   5. C3.5 — double-close rejects with SESSION_ALREADY_CLOSED (not a
//      silent no-op), and the rejection emits an audit event.
//   6. C3.6 — TTL expiry is enforced lazily on the next governed call;
//      no background sweeper required.
//   7. C3.7 — the documented default TTL (86400 s) applies when
//      GIF_SESSION_TTL_SECONDS is unset (boundary bracket).
//
// Requires: MCP server running on port 3100, test_setup.mjs run first.
// Run from gif/mcp-server/:
//   node conformance/c3_closure.mjs
// =============================================================================

import pg from 'pg';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Admin pool — used ONLY for setup: discovering seeded personas and the
// started_at backdate UPDATEs for the TTL cases (C3.6, C3.7). No conformance
// assertion reads from this pool.
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
// MCP client — one persistent connection for the whole scenario
// ---------------------------------------------------------------------------

const MCP_URL = process.env.MCP_BASE_URL || 'http://localhost:3100';
const transport = new StreamableHTTPClientTransport(new URL(`${MCP_URL}/mcp`));
const client = new Client(
  { name: 'gif-conformance-c3', version: '0.1.0' },
  { capabilities: {} },
);
await client.connect(transport);

console.log('\n[c3] GIF-022 Category 3 — Closure\n');

// ---------------------------------------------------------------------------
// Setup — discover approved personas seeded by test_setup.mjs.
//
// subjectA + subjectB: two approved+active personas with read + tool_registry
//   scope. Used to exercise closure and ownership-mismatch.
// auditReader:         approved+active persona with read + audit_events scope.
//   Holds a long-lived session handle (auditReaderSession) used for all
//   db_read(audit_events) assertions.
// ---------------------------------------------------------------------------

let subjectA;
let subjectB;
let auditReaderPersonaId;

try {
  // Two personas with read + tool_registry scope (mirrors test_session_dispatch.mjs).
  const subjectsResult = await adminPool.query(
    `SELECT persona_id FROM gif.personas
      WHERE status = 'active'
        AND governance_review_status = 'approved'
        AND scope_definition->'permitted_actions' ? 'read'
        AND scope_definition->'permitted_sources' ? 'tool_registry'
      ORDER BY created_at
      LIMIT 2`,
  );
  if (subjectsResult.rows.length < 2) {
    throw new Error(
      'Need 2 approved personas with read+tool_registry scope — run test_setup.mjs first',
    );
  }
  subjectA = subjectsResult.rows[0].persona_id;
  subjectB = subjectsResult.rows[1].persona_id;

  // Audit reader: persona with read + audit_events scope (mirrors c1_handle_mint.mjs).
  const auditReaderResult = await adminPool.query(
    `SELECT persona_id FROM gif.personas
      WHERE status = 'active'
        AND governance_review_status = 'approved'
        AND scope_definition->'permitted_actions' ? 'read'
        AND scope_definition->'permitted_sources' ? 'audit_events'
      ORDER BY created_at
      LIMIT 1`,
  );
  if (auditReaderResult.rows.length !== 1) {
    throw new Error(
      'No persona with read+audit_events scope found — run test_setup.mjs first',
    );
  }
  auditReaderPersonaId = auditReaderResult.rows[0].persona_id;

  console.log(
    `[c3] Setup: subjectA=${subjectA.slice(0, 8)}..., ` +
    `subjectB=${subjectB.slice(0, 8)}..., ` +
    `auditReader=${auditReaderPersonaId.slice(0, 8)}...\n`,
  );
} catch (err) {
  console.error('[c3] Setup failed:', err.message);
  await client.close().catch(() => {});
  await adminPool.end();
  process.exit(1);
}

// Mint a session for the audit reader once — reused across all audit assertions.
let auditReaderSession;
{
  const result = await client.callTool({
    name: 'session_start',
    arguments: { persona_id: auditReaderPersonaId },
  });
  auditReaderSession = parseToolResult(result).gif_session_id;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function startSession(personaId) {
  const r = await client.callTool({
    name: 'session_start',
    arguments: { persona_id: personaId },
  });
  return parseToolResult(r).gif_session_id;
}

async function dbReadToolRegistry(personaId, gifSessionId) {
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

// readAuditEvents routes ALL audit assertions through the MCP surface —
// never through the admin pool. This is the conformance discipline.
async function readAuditEvents(filters) {
  const result = await client.callTool({
    name: 'db_read',
    arguments: {
      persona_id:     auditReaderPersonaId,
      gif_session_id: auditReaderSession,
      table:          'audit_events',
      filters:        JSON.stringify(filters),
      limit:          1000,
    },
  });
  return parseToolResult(result); // { table, row_count, rows }
}

// ---------------------------------------------------------------------------
// Case 1 — C3.1: session_close is exposed via tools/list.
// ---------------------------------------------------------------------------

const toolList = await client.listTools();
const sessionCloseDef = toolList.tools.find(t => t.name === 'session_close');

if (sessionCloseDef) {
  pass('C3.1 — session_close is discoverable via tools/list');
} else {
  fail('C3.1 — session_close must appear in tools/list',
       `tools returned: ${toolList.tools.map(t => t.name).join(', ')}`);
}

// ---------------------------------------------------------------------------
// Case 2 — C3.2: session_close.inputSchema.required includes both persona_id
// and gif_session_id.
// ---------------------------------------------------------------------------

if (!sessionCloseDef) {
  fail('C3.2 — cannot evaluate without C3.1');
} else {
  const required    = sessionCloseDef.inputSchema?.required ?? [];
  const hasPersona  = Array.isArray(required) && required.includes('persona_id');
  const hasSession  = Array.isArray(required) && required.includes('gif_session_id');

  // Optionally assert both are typed as string.
  const personaDef  = sessionCloseDef.inputSchema?.properties?.persona_id;
  const sessionDef  = sessionCloseDef.inputSchema?.properties?.gif_session_id;

  if (hasPersona && hasSession) {
    pass(
      'C3.2 — session_close.inputSchema.required includes persona_id' +
      ` (type=${personaDef?.type}) and gif_session_id (type=${sessionDef?.type})`,
    );
  } else {
    fail('C3.2 — session_close must require both persona_id and gif_session_id',
         `required=${JSON.stringify(required)}`);
  }
}

// ---------------------------------------------------------------------------
// Case 3 — C3.3: ownership is validated before any state change.
//
// Mint h3 as subjectA, then attempt to close it as subjectB. The close MUST
// be rejected with SESSION_PERSONA_MISMATCH (assertion 1). Then prove no
// state change occurred: dbReadToolRegistry(subjectA, h3) MUST succeed
// (not isError), showing the session is still open because the ownership
// check ran before any ended_at write (assertion 2).
//
// C3.3 asserts only rejection + no-state-change through the MCP surface; the
// "rejection emits an audit" property is exercised separately in C3.5.
// ---------------------------------------------------------------------------

const h3 = await startSession(subjectA);

{
  const result = await client.callTool({
    name: 'session_close',
    arguments: { persona_id: subjectB, gif_session_id: h3 },
  });
  const parsed = parseToolResult(result);

  if (result.isError === true && parsed.error === 'SESSION_PERSONA_MISMATCH') {
    pass('C3.3 (assertion 1) — non-owning persona rejected with SESSION_PERSONA_MISMATCH');
  } else {
    fail('C3.3 (assertion 1) — non-owning close must reject with SESSION_PERSONA_MISMATCH',
         JSON.stringify(parsed));
  }

  // MCP-surface witness that the session was NOT mutated by the failed close:
  // if ended_at had been set, the next governed call would return SESSION_CLOSED.
  // A successful db_read here proves the session is still open.
  const witnessResult = await dbReadToolRegistry(subjectA, h3);

  if (!witnessResult.isError) {
    pass('C3.3 (assertion 2) — session remains open after ownership-mismatch rejection ' +
         '(no state change; ended_at was not set)');
  } else {
    const witnessParsed = parseToolResult(witnessResult);
    fail('C3.3 (assertion 2) — session must still be open after ownership-mismatch rejection',
         JSON.stringify(witnessParsed));
  }
}

// ---------------------------------------------------------------------------
// Case 4 — C3.4: successful close is a dual-write — ended_at set AND audit
// event emitted. Both writes are part of the successful-close commitment;
// an implementation that does only one is non-conformant.
//
// Assertions:
//   1. The session_close call returns NOT isError and parsed.closed === true.
//   2. Exactly one session_close audit event exists for h4 (the audit write).
//   3. dbReadToolRegistry(subjectA, h4) returns isError+SESSION_CLOSED —
//      witnesses that ended_at was actually set (the ended_at write).
//
// Asserting BOTH the audit row (assertion 2) AND the SESSION_CLOSED follow-on
// (assertion 3) is how the dual-write commitment is verified: neither write
// alone is conformant per GIF-022 C3.4.
//
// h4 is kept in scope for C3.5 (double-close).
// ---------------------------------------------------------------------------

const h4 = await startSession(subjectA);

{
  const closeResult = await client.callTool({
    name: 'session_close',
    arguments: { persona_id: subjectA, gif_session_id: h4 },
  });
  const closeParsed = parseToolResult(closeResult);

  if (!closeResult.isError && closeParsed.closed === true) {
    pass('C3.4 (assertion 1) — session_close returns closed:true for the owning persona');
  } else {
    fail('C3.4 (assertion 1) — session_close must return closed:true for the owner',
         JSON.stringify(closeParsed));
  }

  // Brief delay for the fire-and-forget audit INSERT to land.
  await new Promise(r => setTimeout(r, 200));

  // Assertion 2: audit row exists (the audit write half of the dual-write).
  const auditRead = await readAuditEvents({
    session_id: h4,
    event_type: 'session_close',
  });

  if (auditRead.row_count === 1) {
    pass('C3.4 (assertion 2) — exactly one session_close audit event linked to the handle ' +
         '(audit write confirmed)');
  } else {
    fail('C3.4 (assertion 2) — session_close audit event count mismatch',
         `row_count=${auditRead.row_count}, expected 1`);
  }

  // Assertion 3: SESSION_CLOSED on the next governed call witnesses that
  // ended_at was set (the ended_at write half of the dual-write).
  const dispatchResult = await dbReadToolRegistry(subjectA, h4);
  const dispatchParsed = parseToolResult(dispatchResult);

  if (dispatchResult.isError === true && dispatchParsed.reason === 'SESSION_CLOSED') {
    pass('C3.4 (assertion 3) — closed handle rejected with SESSION_CLOSED ' +
         '(ended_at write confirmed via lazy enforcement)');
  } else {
    fail('C3.4 (assertion 3) — closed session must reject with SESSION_CLOSED on next governed call',
         JSON.stringify(dispatchParsed));
  }
}

// ---------------------------------------------------------------------------
// Case 5 — C3.5: double-close rejects with SESSION_ALREADY_CLOSED (not a
// silent no-op) and the rejection emits an audit event.
//
// Reuses h4 (already closed in C3.4).
// ---------------------------------------------------------------------------

{
  // Second close on an already-closed session.
  const result = await client.callTool({
    name: 'session_close',
    arguments: { persona_id: subjectA, gif_session_id: h4 },
  });
  const parsed = parseToolResult(result);

  if (result.isError === true && parsed.error === 'SESSION_ALREADY_CLOSED') {
    pass('C3.5 (assertion 1) — double-close rejected with SESSION_ALREADY_CLOSED ' +
         '(not a silent no-op)');
  } else {
    fail('C3.5 (assertion 1) — double-close must reject with SESSION_ALREADY_CLOSED',
         JSON.stringify(parsed));
  }

  // Brief delay for the fire-and-forget audit INSERT to land.
  await new Promise(r => setTimeout(r, 200));

  // Assertion 2: the rejection emits an audit event. Filter by session_id +
  // event_type + source_ref + tool_name to isolate the double-close attempt
  // from any other session_rejected_closed rows on h4.
  const auditRead = await readAuditEvents({
    session_id: h4,
    event_type: 'session_rejected_closed',
    source_ref: 'SESSION_ALREADY_CLOSED',
    tool_name:  'session_close',
  });

  if (auditRead.row_count === 1) {
    pass('C3.5 (assertion 2) — double-close rejection emits audit event ' +
         '(session_rejected_closed / SESSION_ALREADY_CLOSED)');
  } else {
    fail('C3.5 (assertion 2) — double-close rejection audit event count mismatch',
         `row_count=${auditRead.row_count}, expected 1`);
  }
}

// ---------------------------------------------------------------------------
// Case 6 — C3.6: TTL expiry is enforced lazily on the next governed call.
//
// Mint h6 as subjectA, then backdate started_at by 25 hours via admin pool
// (setup-only mutation). The next governed call MUST reject with
// SESSION_EXPIRED. No background sweeper is required by a conformant
// implementation — expiry surfaces on the FIRST governed call after the TTL
// boundary (GIF-020 F5 stateless-dispatch).
// ---------------------------------------------------------------------------

const h6 = await startSession(subjectA);

// Admin-pool backdate: setup-only use. TTL default is 86400 s (24 h);
// 25 h guarantees the session is expired.
await adminPool.query(
  `UPDATE gif.sessions
      SET started_at = now() - interval '25 hours'
    WHERE session_id = $1`,
  [h6],
);

{
  const result = await dbReadToolRegistry(subjectA, h6);
  const parsed = parseToolResult(result);

  if (result.isError === true && parsed.reason === 'SESSION_EXPIRED') {
    // Expiry surfaces on the FIRST governed call after the TTL boundary —
    // lazy enforcement, no background sweeper required (C3.6, GIF-020 F5).
    pass('C3.6 — TTL-expired handle rejected with SESSION_EXPIRED on the next ' +
         'governed call (lazy enforcement confirmed; no sweeper required)');
  } else {
    fail('C3.6 — expired handle must reject with SESSION_EXPIRED',
         JSON.stringify(parsed));
  }
}

// ---------------------------------------------------------------------------
// Case 7 — C3.7: the documented default TTL (86400 s) applies when
// GIF_SESSION_TTL_SECONDS is unset.
//
// The running test server uses the default TTL (nothing overrides
// GIF_SESSION_TTL_SECONDS). Bracket the boundary with two handles:
//
//   h7valid   — backdated 23 hours (under 24 h) → MUST be accepted.
//   h7expired — backdated 25 hours (over 24 h)  → MUST be rejected.
//
// A session aged 23 h is valid and one aged 25 h is expired, which
// demonstrates the effective TTL is ~86 400 s. This is a behavioral bracket —
// the harness cannot read process env directly, so it brackets the boundary
// instead of asserting the env value directly. (C3.7)
// ---------------------------------------------------------------------------

const h7valid   = await startSession(subjectA);
const h7expired = await startSession(subjectA);

// Backdate h7valid by 23 hours — within the default 24 h TTL.
await adminPool.query(
  `UPDATE gif.sessions
      SET started_at = now() - interval '23 hours'
    WHERE session_id = $1`,
  [h7valid],
);

// Backdate h7expired by 25 hours — outside the default 24 h TTL.
await adminPool.query(
  `UPDATE gif.sessions
      SET started_at = now() - interval '25 hours'
    WHERE session_id = $1`,
  [h7expired],
);

{
  // Assertion 1: h7valid (23 h) is still within TTL — MUST succeed.
  const validResult = await dbReadToolRegistry(subjectA, h7valid);

  if (!validResult.isError) {
    pass('C3.7 (assertion 1) — session aged 23 h is still valid (within default 86400 s TTL)');
  } else {
    const validParsed = parseToolResult(validResult);
    fail('C3.7 (assertion 1) — session aged 23 h must be accepted under default TTL',
         JSON.stringify(validParsed));
  }

  // Assertion 2: h7expired (25 h) is outside TTL — MUST reject with SESSION_EXPIRED.
  const expiredResult = await dbReadToolRegistry(subjectA, h7expired);
  const expiredParsed = parseToolResult(expiredResult);

  if (expiredResult.isError === true && expiredParsed.reason === 'SESSION_EXPIRED') {
    pass('C3.7 (assertion 2) — session aged 25 h is expired (outside default 86400 s TTL)');
  } else {
    fail('C3.7 (assertion 2) — session aged 25 h must reject with SESSION_EXPIRED',
         JSON.stringify(expiredParsed));
  }

  // Both assertions together prove the effective TTL is ~86 400 s,
  // demonstrating the documented default applies when GIF_SESSION_TTL_SECONDS
  // is unset (C3.7).
}

// ---------------------------------------------------------------------------
// Cleanup — close the audit reader's session; leave all other handles to
// TTL out (append-only convention: sessions and audit_events are never
// manually deleted). Do not delete subject personas (seeded, not disposable).
// ---------------------------------------------------------------------------

try {
  await client.callTool({
    name: 'session_close',
    arguments: { persona_id: auditReaderPersonaId, gif_session_id: auditReaderSession },
  });
} catch (err) {
  console.error('[c3] Cleanup warning (session_close):', err.message);
}

await client.close();
await adminPool.end();

console.log(`\n[c3] Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('[c3] GIF-022 CATEGORY 3 CONFORMANCE FAILED');
  process.exit(1);
} else {
  console.log('[c3] GIF-022 Category 3 conformance passed');
}
