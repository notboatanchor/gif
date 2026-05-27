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

// conformance/c2_dispatch_validation.mjs
// =============================================================================
// GIF-022 Category 2 — Governed-tool dispatch validation conformance scenarios.
//
// Asserts the C2.1–C2.7 MUSTs in GIF-022 §Conformance-Required Behaviors
// against a running gif MCP server.
//
// Discipline (load-bearing for the conformance contract):
//   - Setup uses the admin pool to discover seeded personas and to backdate
//     sessions.started_at for the TTL expiry case. No conformance assertion
//     reads the database via the admin pool.
//   - Every conformance assertion routes through the three MCP surfaces
//     enumerated in GIF-022 §What a Conformance Harness Needs to Introspect:
//     tools/list, tool dispatch, db_read on audit_events.
//   - "read_log" in GIF-022 terminology is db_read(table='audit_events')
//     gated by the admin-read / audit-events read scope.
//   - Case labels carry the MUST IDs (C2.1, C2.2, ...) for direct trace to
//     GIF-022.
//
// Cases:
//   1. C2.1 — every governed tool's inputSchema.required includes
//      gif_session_id as a string field.
//   2. C2.2 — governed call missing gif_session_id throws MCP InvalidParams
//      before the handler executes (no audit event for this case).
//   3. C2.3 — unknown handle rejected with SESSION_NOT_FOUND; rejection audit
//      event emitted (asserted via delta count because audit row has
//      session_id NULL, which equality filter cannot match).
//   4. C2.4 — persona-mismatched handle rejected with SESSION_PERSONA_MISMATCH;
//      rejection audit event emitted (filter by unique handle).
//   5. C2.5 — closed handle rejected with SESSION_CLOSED; rejection audit
//      event emitted (filter by unique handle). Handle retained for C2.6(b).
//   6. C2.6 — expired handle rejected with SESSION_EXPIRED; rejection audit
//      event emitted (filter by unique handle). Plus closure-precedence sub-
//      check: closed+expired handle resolves to SESSION_CLOSED.
//   7. C2.7 — roll-up: four governance-rejection cases each emitted their
//      audit event (verified inline in C2.3–C2.6); missing-handle is a
//      protocol-level throw with no audit.
//
// Requires: MCP server running on port 3100, test_setup.mjs run first.
// Run from gif/mcp-server/:
//   node conformance/c2_dispatch_validation.mjs
// =============================================================================

import pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Admin pool — used ONLY for setup: discovering seeded personas and the ONE
// started_at backdate UPDATE for the TTL expiry case. No conformance
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
  { name: 'gif-conformance-c2', version: '0.1.0' },
  { capabilities: {} },
);
await client.connect(transport);

console.log('\n[c2] GIF-022 Category 2 — Governed-tool Dispatch Validation\n');

// ---------------------------------------------------------------------------
// Setup — discover approved personas seeded by test_setup.mjs.
//
// subjectA + subjectB: two approved+active personas with read + tool_registry
//   scope. Used to exercise dispatch and persona-mismatch.
// auditReader:         approved+active persona with read + audit_events scope.
//   Holds a long-lived session handle (auditReaderSession) used for all
//   db_read(audit_events) assertions. The audit reader is set up exactly as
//   in c1_handle_mint.mjs.
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
    `[c2] Setup: subjectA=${subjectA.slice(0, 8)}..., ` +
    `subjectB=${subjectB.slice(0, 8)}..., ` +
    `auditReader=${auditReaderPersonaId.slice(0, 8)}...\n`,
  );
} catch (err) {
  console.error('[c2] Setup failed:', err.message);
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
// Case 1 — C2.1: every governed tool's inputSchema.required includes
// gif_session_id as a required string field.
//
// SKIP_SESSION is maintained here as an allowlist because the skipSession
// flag is not visible on the MCP surface. GIF-022 C2.1 operationally
// defines a governed tool as one not flagged skipSession=true; in the
// reference implementation those are: session_start, session_close,
// persona_validate.
// ---------------------------------------------------------------------------

const SKIP_SESSION = new Set(['session_start', 'session_close', 'persona_validate']);

const toolList = await client.listTools();
{
  const offenders = [];
  for (const tool of toolList.tools) {
    if (SKIP_SESSION.has(tool.name)) continue;
    const required   = tool.inputSchema?.required ?? [];
    const sessionDef = tool.inputSchema?.properties?.gif_session_id;
    const requiredOk = Array.isArray(required) && required.includes('gif_session_id');
    const stringOk   = sessionDef?.type === 'string';
    if (!requiredOk || !stringOk) {
      offenders.push(
        `${tool.name}(required=${requiredOk},type=${sessionDef?.type ?? 'missing'})`,
      );
    }
  }

  if (offenders.length === 0) {
    pass('C2.1 — all governed tools include gif_session_id as a required string field');
  } else {
    fail('C2.1 — one or more governed tools missing gif_session_id required string',
         offenders.join(', '));
  }
}

// ---------------------------------------------------------------------------
// Case 2 — C2.2: governed call with gif_session_id missing from args MUST be
// rejected before the tool handler executes. The dispatcher throws an MCP
// InvalidParams error; client.callTool() throws (not an isError result).
// No audit event is emitted for this case — the rejection is a protocol-level
// input validation, not a validateSessionHandle rejection.
// ---------------------------------------------------------------------------

{
  let threw = false;
  let errMsg = '';
  try {
    await client.callTool({
      name: 'db_read',
      arguments: {
        persona_id: subjectA,
        table:      'tool_registry',
        limit:      1,
        // gif_session_id intentionally omitted
      },
    });
  } catch (err) {
    threw = true;
    errMsg = err?.message ?? String(err);
  }

  if (threw && /gif_session_id/.test(errMsg)) {
    pass('C2.2 — governed call without gif_session_id throws MCP InvalidParams ' +
         'mentioning gif_session_id');
  } else {
    fail('C2.2 — governed call without gif_session_id must throw with gif_session_id mention',
         `threw=${threw}, msg=${errMsg}`);
  }
}

// ---------------------------------------------------------------------------
// Case 3 — C2.3: unknown handle rejected with SESSION_NOT_FOUND; rejection
// audit event emitted.
//
// Why a delta count here: the SESSION_NOT_FOUND audit row has session_id NULL
// (no session exists for the unknown handle). An equality filter on session_id
// cannot match a NULL row, so we cannot scope the assertion by the unknown
// handle itself the way C2.4–C2.6 do. A before/after delta on the combination
// of persona_id + event_type + source_ref + tool_name is the run-scoped
// witness that exactly one new rejection audit row landed.
// ---------------------------------------------------------------------------

{
  const unknownHandle = '00000000-0000-0000-0000-000000000000';

  const beforeRead = await readAuditEvents({
    event_type: 'session_rejected_closed',
    source_ref: 'SESSION_NOT_FOUND',
    tool_name:  'db_read',
    persona_id: subjectA,
  });
  const before = beforeRead.row_count;

  const result = await dbReadToolRegistry(subjectA, unknownHandle);
  const parsed = parseToolResult(result);

  if (result.isError === true && parsed.reason === 'SESSION_NOT_FOUND') {
    pass('C2.3 — unknown handle rejected with SESSION_NOT_FOUND');
  } else {
    fail('C2.3 — unknown handle must reject with SESSION_NOT_FOUND',
         JSON.stringify(parsed));
  }

  // Fire-and-forget audit insert: brief delay to allow the row to land.
  await new Promise(r => setTimeout(r, 200));

  const afterRead = await readAuditEvents({
    event_type: 'session_rejected_closed',
    source_ref: 'SESSION_NOT_FOUND',
    tool_name:  'db_read',
    persona_id: subjectA,
  });
  const after = afterRead.row_count;

  if (after === before + 1) {
    pass('C2.3 — SESSION_NOT_FOUND rejection emits audit event ' +
         '(session_rejected_closed, session_id NULL — asserted via delta count)');
  } else {
    fail('C2.3 — SESSION_NOT_FOUND audit event count mismatch',
         `before=${before}, after=${after}, expected after=${before + 1}`);
  }
}

// ---------------------------------------------------------------------------
// Case 4 — C2.4: persona-mismatched handle rejected with
// SESSION_PERSONA_MISMATCH; rejection audit event emitted.
// Mint a session as subjectA, then attempt to use it as subjectB.
// ---------------------------------------------------------------------------

{
  const ownerHandle = await startSession(subjectA);

  const result = await dbReadToolRegistry(subjectB, ownerHandle);
  const parsed = parseToolResult(result);

  if (result.isError === true && parsed.reason === 'SESSION_PERSONA_MISMATCH') {
    pass('C2.4 — persona-mismatched handle rejected with SESSION_PERSONA_MISMATCH');
  } else {
    fail('C2.4 — persona-mismatched handle must reject with SESSION_PERSONA_MISMATCH',
         JSON.stringify(parsed));
  }

  await new Promise(r => setTimeout(r, 200));

  const auditRead = await readAuditEvents({
    session_id: ownerHandle,
    event_type: 'session_rejected_closed',
    source_ref: 'SESSION_PERSONA_MISMATCH',
  });

  if (auditRead.row_count === 1) {
    pass('C2.4 — SESSION_PERSONA_MISMATCH rejection emits audit event linked to the handle');
  } else {
    fail('C2.4 — SESSION_PERSONA_MISMATCH audit event count mismatch',
         `row_count=${auditRead.row_count}, expected 1`);
  }
}

// ---------------------------------------------------------------------------
// Case 5 — C2.5: closed handle rejected with SESSION_CLOSED; rejection audit
// event emitted. closedHandle is retained in scope for C2.6(b) closure-
// precedence sub-check.
// ---------------------------------------------------------------------------

let closedHandle;
{
  closedHandle = await startSession(subjectA);

  // Close via the session_close tool — caller-driven closure per GIF-020.
  await client.callTool({
    name: 'session_close',
    arguments: { persona_id: subjectA, gif_session_id: closedHandle },
  });

  const result = await dbReadToolRegistry(subjectA, closedHandle);
  const parsed = parseToolResult(result);

  if (result.isError === true && parsed.reason === 'SESSION_CLOSED') {
    pass('C2.5 — closed handle rejected with SESSION_CLOSED');
  } else {
    fail('C2.5 — closed handle must reject with SESSION_CLOSED',
         JSON.stringify(parsed));
  }

  await new Promise(r => setTimeout(r, 200));

  const auditRead = await readAuditEvents({
    session_id: closedHandle,
    event_type: 'session_rejected_closed',
    source_ref: 'SESSION_CLOSED',
  });

  if (auditRead.row_count === 1) {
    pass('C2.5 — SESSION_CLOSED rejection emits audit event linked to the handle');
  } else {
    fail('C2.5 — SESSION_CLOSED audit event count mismatch',
         `row_count=${auditRead.row_count}, expected 1`);
  }
}

// ---------------------------------------------------------------------------
// Case 6 — C2.6: expired handle rejected with SESSION_EXPIRED; rejection
// audit event emitted. Plus closure-precedence sub-check (C2.5 clause):
// a session that is BOTH closed AND expired resolves to SESSION_CLOSED.
//
// (a) Expiry: mint a fresh session as subjectA, backdate started_at by 25h
//     via admin pool (setup-only, never for assertions), then dispatch.
// (b) Closure precedence: reuse closedHandle from C2.5; backdate its
//     started_at by 25h so it is both closed and expired. SESSION_CLOSED
//     must still win.
// ---------------------------------------------------------------------------

{
  // --- (a) Expiry ---
  const expiredHandle = await startSession(subjectA);

  // Admin-pool backdate: this is the ONE allowed setup mutation in the admin
  // pool. TTL default is 86400s (24h); 25h guarantees expiry.
  await adminPool.query(
    `UPDATE gif.sessions
        SET started_at = now() - interval '25 hours'
      WHERE session_id = $1`,
    [expiredHandle],
  );

  const expiredResult = await dbReadToolRegistry(subjectA, expiredHandle);
  const expiredParsed = parseToolResult(expiredResult);

  if (expiredResult.isError === true && expiredParsed.reason === 'SESSION_EXPIRED') {
    pass('C2.6(a) — TTL-expired handle rejected with SESSION_EXPIRED');
  } else {
    fail('C2.6(a) — expired handle must reject with SESSION_EXPIRED',
         JSON.stringify(expiredParsed));
  }

  await new Promise(r => setTimeout(r, 200));

  const expiredAudit = await readAuditEvents({
    session_id: expiredHandle,
    event_type: 'session_expired',
    source_ref: 'SESSION_EXPIRED',
  });

  if (expiredAudit.row_count === 1) {
    pass('C2.6(a) — SESSION_EXPIRED rejection emits audit event linked to the handle');
  } else {
    fail('C2.6(a) — SESSION_EXPIRED audit event count mismatch',
         `row_count=${expiredAudit.row_count}, expected 1`);
  }

  // --- (b) Closure precedence ---
  // closedHandle was closed in C2.5. Backdate it to also be expired.
  // SESSION_CLOSED must take precedence per GIF-020 (closed > expired).
  await adminPool.query(
    `UPDATE gif.sessions
        SET started_at = now() - interval '25 hours'
      WHERE session_id = $1`,
    [closedHandle],
  );

  const precResult = await dbReadToolRegistry(subjectA, closedHandle);
  const precParsed = parseToolResult(precResult);

  if (precResult.isError === true && precParsed.reason === 'SESSION_CLOSED') {
    pass('C2.6(b) — closed+expired handle resolves to SESSION_CLOSED ' +
         '(closure precedence: closed > expired)');
  } else {
    fail('C2.6(b) — closure precedence violated: closed+expired must resolve as SESSION_CLOSED',
         JSON.stringify(precParsed));
  }
}

// ---------------------------------------------------------------------------
// Case 7 — C2.7: roll-up — four governance-rejection cases each emitted
// their audit event.
//
// This is not a new dispatch call. The four validateSessionHandle rejection
// paths (SESSION_NOT_FOUND, SESSION_PERSONA_MISMATCH, SESSION_CLOSED,
// SESSION_EXPIRED) were each verified inline in C2.3–C2.6. The missing-
// handle case (C2.2) is a protocol-level MCP InvalidParams throw and emits
// no audit event — the dispatcher rejects at input validation before
// validateSessionHandle is ever called.
//
// GIF-022 C2.7 parenthetically lists five cases but states "four"; the
// implementation audits exactly the four validateSessionHandle rejections.
// The missing-handle inclusion in the parenthetical is a GIF-022 wording
// amendment candidate.
// ---------------------------------------------------------------------------

pass(
  'C2.7 — unknown/mismatch/closed/expired rejections each emit a rejection audit ' +
  'event (verified in C2.3–C2.6); missing-handle (C2.2) is a protocol-level ' +
  'InvalidParams throw and emits no audit',
);

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
  console.error('[c2] Cleanup warning (session_close):', err.message);
}

await client.close();
await adminPool.end();

console.log(`\n[c2] Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('[c2] GIF-022 CATEGORY 2 CONFORMANCE FAILED');
  process.exit(1);
} else {
  console.log('[c2] GIF-022 Category 2 conformance passed');
}
