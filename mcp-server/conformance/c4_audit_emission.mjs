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

// conformance/c4_audit_emission.mjs
// =============================================================================
// GIF-022 Category 4 — Audit event emission conformance scenarios.
//
// Asserts the C4.1–C4.5 MUSTs in GIF-022 §Conformance-Required Behaviors
// against a running gif MCP server.
//
// Discipline (load-bearing for the conformance contract):
//   - Default rule: admin pool for setup only; every conformance assertion
//     routes through the three MCP surfaces in GIF-022 §What a Conformance
//     Harness Needs to Introspect: tools/list, tool dispatch, db_read on
//     audit_events.
//   - Exception 1 (C4.1): C4.1 is a DB-permission MUST with no MCP surface
//     (no MCP tool performs UPDATE/DELETE on audit_events). It is verified by a
//     direct mutation attempt as the application role (gif_app) via a dedicated
//     appPool. This exception is explicitly documented in the C4.1 block.
//   - Exception 2 (C4.5 gating-negative): uses the admin pool to create ONE
//     disposable persona that lacks audit_events read scope. Documented setup
//     use, like c1's unapproved-persona pattern.
//   - I2 awareness: Audit assertions key on the conformance-required event_type
//     values (session_start, session_close, session_expired,
//     session_rejected_closed), NOT on the implementation-defined wire codes
//     (SESSION_EXPIRED, SESSION_CLOSED, etc.). Where a rejection is observed,
//     the conformance signal is result.isError === true plus the required
//     event_type in the audit row — any parsed.reason wire code is incidental.
//   - "read_log" in GIF-022 terminology is db_read(table='audit_events') gated
//     by the audit-events read scope. There is no standalone read_log tool.
//   - Case labels carry the MUST IDs (C4.1–C4.5) for direct trace to GIF-022.
//
// Cases:
//   1. C4.1 — audit_events is INSERT-only at the DB permission level; UPDATE
//      and DELETE are blocked for the application role.
//   2. C4.2 + C4.3 — the four lifecycle event types (session_start,
//      session_close, session_expired, session_rejected_closed) are emitted
//      in their canonical conditions, each linked to a session_id.
//   3. C4.4 — audit emission does not throw into the tool response path
//      (observable proxy: success-path governed call returns a real result).
//   4. C4.5 — audit trail is readable via db_read(audit_events) and is
//      scope-gated (persona without audit_events in permitted_sources is denied).
//
// GIF-022 §C4.5 amendment candidates (wording discrepancies, logged here for
// the follow-on spec revision):
//   (1) There is no standalone "read_log" MCP tool — the audit-read surface is
//       db_read(table='audit_events').
//   (2) C4.5 says the audit trail is read "with admin_read action", but the
//       implementation gates audit_events behind the "read" action +
//       "audit_events" in permitted_sources (audit-class read scope).
//       "admin_read" gates only the personas table (C6.2), not the audit trail.
//       Both wire-name and action-name in C4.5 need amendment before the spec
//       ships externally.
//
// Requires: MCP server running on port 3100, test_setup.mjs run first.
// Run from gif/mcp-server/:
//   node conformance/c4_audit_emission.mjs
// =============================================================================

import pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Admin pool — used ONLY for setup: discovering seeded personas, backdating
// sessions.started_at for the TTL-expired case (C4.2/C4.3), and inserting the
// C4.5 gating-negative disposable persona. No conformance assertion reads from
// this pool.
// ---------------------------------------------------------------------------

const adminPool = new Pool({
  host:     process.env.PGHOST          || 'localhost',
  port:     parseInt(process.env.PGPORT || '5432'),
  user:     process.env.PGADMINUSER     || 'gif_admin',
  password: process.env.PGADMINPASSWORD,
  database: process.env.PGDATABASE      || 'gif',
});

// ---------------------------------------------------------------------------
// App pool — used ONLY for C4.1: attempting the forbidden UPDATE/DELETE
// mutations as the application role (gif_app). This is the documented
// Exception 1 for C4.1 — a DB-permission MUST with no MCP surface.
// ---------------------------------------------------------------------------

const appPool = new Pool({
  host:     process.env.PGHOST     || 'localhost',
  port:     parseInt(process.env.PGPORT || '5432'),
  user:     process.env.PGUSER     || 'gif_app',
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'gif',
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
  { name: 'gif-conformance-c4', version: '0.1.0' },
  { capabilities: {} },
);
await client.connect(transport);

console.log('\n[c4] GIF-022 Category 4 — Audit Event Emission\n');

// ---------------------------------------------------------------------------
// Setup — discover approved personas seeded by test_setup.mjs.
//
// subjectA + subjectB: two approved+active personas with read + tool_registry
//   scope. Used to generate lifecycle events and ownership-differentiated
//   calls for C4.2/C4.3.
// auditReader:         approved+active persona with read + audit_events scope.
//   Holds a long-lived session handle (auditReaderSession) used for all
//   db_read(audit_events) assertions.
// noAuditPersona:      freshly inserted disposable persona with read +
//   tool_registry scope ONLY (no audit_events). Used for C4.5 gating-negative.
// ---------------------------------------------------------------------------

const TEST_TAG = `c4_audit_emission_${Date.now()}`;

let subjectA;
let subjectB;
let auditReaderPersonaId;
let noAuditPersonaId;

try {
  // Two personas with read + tool_registry scope.
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

  // Audit reader: persona with read + audit_events scope.
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

  // C4.5 gating-negative disposable persona: approved + active, read +
  // tool_registry ONLY — deliberately NO audit_events in permitted_sources.
  // Governance status is 'approved' so it can mint sessions and dispatch calls,
  // isolating the scope gate from the governance gate. Documented setup use,
  // like c1's unapproved-persona pattern.
  const noAuditResult = await adminPool.query(
    `INSERT INTO gif.personas
       (issuing_entity, purpose, created_by, scope_definition, valid_until,
        status, governance_review_status)
     VALUES (
       'conformance-c4',
       'C4.5 audit-read gating-negative scenario',
       $1,
       '{"permitted_actions":["read"],"permitted_sources":["tool_registry"],"max_results":1}'::jsonb,
       now() + interval '1 hour',
       'active',
       'approved'
     )
     RETURNING persona_id`,
    [TEST_TAG],
  );
  noAuditPersonaId = noAuditResult.rows[0].persona_id;

  console.log(
    `[c4] Setup: subjectA=${subjectA.slice(0, 8)}..., ` +
    `subjectB=${subjectB.slice(0, 8)}..., ` +
    `auditReader=${auditReaderPersonaId.slice(0, 8)}..., ` +
    `noAuditPersona=${noAuditPersonaId.slice(0, 8)}...\n`,
  );
} catch (err) {
  console.error('[c4] Setup failed:', err.message);
  await client.close().catch(() => {});
  await adminPool.end();
  await appPool.end();
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

// Mint a session for the no-audit persona — used in C4.5 gating-negative.
let noAuditSession;
{
  const result = await client.callTool({
    name: 'session_start',
    arguments: { persona_id: noAuditPersonaId },
  });
  noAuditSession = parseToolResult(result).gif_session_id;
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
// Case 1 — C4.1: audit_events is INSERT-only at the DB permission level.
//
// Exception 1 (documented): C4.1 is a DB-permission MUST with no MCP surface
// — no MCP tool exposes UPDATE or DELETE on audit_events. It is verified by
// attempting the forbidden mutations directly as the application role (gif_app)
// via appPool.
//
// gif enforces append-only via both REVOKE (no UPDATE/DELETE privilege) and RLS
// (no RLS UPDATE/DELETE policy), so either outcome is a conformant block:
//   - rowCount === 0: RLS filtered the row (no policy permits the mutation)
//   - catch with 'permission denied': REVOKE prevented execution entirely
// FAIL only if the mutation actually modifies >= 1 row without error.
//
// The target event_id is obtained through the MCP read surface first (so the
// assertion is grounded in a real row); only the forbidden mutations use the
// app role.
// ---------------------------------------------------------------------------

console.log('[c4] Case 1 — C4.1: audit_events is INSERT-only at DB permission level\n');

{
  // Obtain a real audit event id through the MCP surface.
  let targetEventId = null;

  let initialRead = await readAuditEvents({ event_type: 'session_start' });

  if (initialRead.row_count === 0) {
    // No session_start rows yet — mint one to guarantee a target exists.
    const seedHandle = await startSession(subjectA);
    await new Promise(r => setTimeout(r, 200));
    initialRead = await readAuditEvents({ event_type: 'session_start' });
    void seedHandle; // handle left to TTL; append-only convention
  }

  if (initialRead.row_count > 0) {
    targetEventId = initialRead.rows[0].event_id;
  } else {
    fail('C4.1 — could not obtain a target event_id through the MCP surface',
         'no session_start audit events found even after seeding');
  }

  if (targetEventId !== null) {
    // Assertion 1: UPDATE must be blocked.
    // Exception 1: appPool used here — DB-permission MUST with no MCP surface.
    try {
      const updateResult = await appPool.query(
        `UPDATE audit_events SET flagged = true WHERE event_id = $1`,
        [targetEventId],
      );
      if (updateResult.rowCount === 0) {
        pass('C4.1 (assertion 1) — UPDATE on audit_events blocked ' +
             '(0 rows affected — RLS filtered; no UPDATE policy exists)');
      } else {
        fail(
          'C4.1 (assertion 1) — UPDATE on audit_events must be blocked',
          `modified ${updateResult.rowCount} row(s) — append-only constraint violated`,
        );
      }
    } catch (err) {
      if (err.message.includes('permission denied')) {
        pass('C4.1 (assertion 1) — UPDATE on audit_events blocked ' +
             '(permission denied — REVOKE enforced)');
      } else {
        fail('C4.1 (assertion 1) — UPDATE on audit_events threw unexpected error',
             err.message);
      }
    }

    // Assertion 2: DELETE must be blocked.
    // Exception 1: appPool used here — DB-permission MUST with no MCP surface.
    try {
      const deleteResult = await appPool.query(
        `DELETE FROM audit_events WHERE event_id = $1`,
        [targetEventId],
      );
      if (deleteResult.rowCount === 0) {
        pass('C4.1 (assertion 2) — DELETE on audit_events blocked ' +
             '(0 rows affected — RLS filtered; no DELETE policy exists)');
      } else {
        fail(
          'C4.1 (assertion 2) — DELETE on audit_events must be blocked',
          `deleted ${deleteResult.rowCount} row(s) — append-only constraint violated`,
        );
      }
    } catch (err) {
      if (err.message.includes('permission denied')) {
        pass('C4.1 (assertion 2) — DELETE on audit_events blocked ' +
             '(permission denied — REVOKE enforced)');
      } else {
        fail('C4.1 (assertion 2) — DELETE on audit_events threw unexpected error',
             err.message);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Cases 2 + 3 — C4.2 + C4.3: the four lifecycle event types are emitted in
// their canonical conditions, and each links to a session_id.
//
// All four lifecycle events are generated within this scenario (self-contained).
// Each event type is triggered via its canonical condition and its originating
// handle is captured for filtering.
//
// The four lifecycle conditions (C4.2) and their handles:
//   hStart              — session_start       (C1.5 condition)
//   hClose (close leg)  — session_close       (C3.4 condition)
//   hExpired            — session_expired     (C3.6/C2.6 condition)
//   hClose (reject leg) — session_rejected_closed (C2.5 condition)
//
// hClose carries both session_close and session_rejected_closed events;
// the event_type filter in readAuditEvents separates them.
//
// C4.3 wording note: the SESSION_NOT_FOUND variant of session_rejected_closed
// (unknown-handle dispatch rejection, see C2.3) legitimately carries
// session_id NULL because no session exists — it is outside C4.3's
// "links to a session" scope. This harness asserts only the four canonical
// C4.2 lifecycle conditions, which all link to a real session_id. The NULL
// case is a GIF-022 C4.3 wording nuance; no assertion is made against it.
//
// I2 awareness: assertions key on event_type values, not wire codes. Any
// parsed.reason (SESSION_EXPIRED, SESSION_CLOSED, etc.) is incidental/
// informational only.
// ---------------------------------------------------------------------------

console.log('[c4] Cases 2+3 — C4.2 + C4.3: lifecycle event types emitted and linked\n');

// Generate all four lifecycle conditions.
const hStart   = await startSession(subjectA);      // emits session_start
const hClose   = await startSession(subjectA);      // will emit session_close + session_rejected_closed
const hExpired = await startSession(subjectA);      // will emit session_expired

// Close hClose — emits session_close.
await client.callTool({
  name: 'session_close',
  arguments: { persona_id: subjectA, gif_session_id: hClose },
});

// Backdate hExpired by 25 hours via admin pool (setup-only mutation).
// TTL default is 86400 s (24 h); 25 h guarantees expiry.
await adminPool.query(
  `UPDATE gif.sessions
      SET started_at = now() - interval '25 hours'
    WHERE session_id = $1`,
  [hExpired],
);

// Trigger session_expired: governed call on the now-expired session.
await dbReadToolRegistry(subjectA, hExpired);

// Trigger session_rejected_closed: governed call on the now-closed session.
// hClose.ended_at is already set; this call sees the closed condition (C2.5).
await dbReadToolRegistry(subjectA, hClose);

// Wait for fire-and-forget audit INSERTs to land.
await new Promise(r => setTimeout(r, 250));

// Read back each (event_type, handle) pair through the MCP audit surface.
const lifecycleCases = [
  { event_type: 'session_start',            handle: hStart,   label: 'hStart'   },
  { event_type: 'session_close',            handle: hClose,   label: 'hClose'   },
  { event_type: 'session_expired',          handle: hExpired, label: 'hExpired' },
  { event_type: 'session_rejected_closed',  handle: hClose,   label: 'hClose (reject leg)' },
];

const lifecycleReads = {};
for (const { event_type, handle, label } of lifecycleCases) {
  const read = await readAuditEvents({ session_id: handle, event_type });
  lifecycleReads[`${event_type}:${handle}`] = { read, label };
}

// C4.2 assertion: all four event types returned at least one row.
{
  const missing = [];
  for (const { event_type, handle, label } of lifecycleCases) {
    const { read } = lifecycleReads[`${event_type}:${handle}`];
    if (read.row_count < 1) {
      missing.push(`${event_type} (${label})`);
    }
  }
  if (missing.length === 0) {
    pass(
      'C4.2 — all four lifecycle event types emitted: ' +
      'session_start, session_close, session_expired, session_rejected_closed',
    );
  } else {
    fail('C4.2 — missing lifecycle audit event type(s)',
         missing.join(', '));
  }
}

// C4.3 assertion: for each of the four reads, rows[0].session_id is non-null
// AND equals the expected handle.
{
  const mismatches = [];
  for (const { event_type, handle, label } of lifecycleCases) {
    const { read } = lifecycleReads[`${event_type}:${handle}`];
    if (read.row_count < 1) {
      mismatches.push(`${event_type} (${label}): no row returned (C4.2 failure)`);
      continue;
    }
    const rowSessionId = read.rows[0].session_id;
    if (rowSessionId === null || rowSessionId === undefined) {
      mismatches.push(`${event_type} (${label}): session_id is null`);
    } else if (rowSessionId !== handle) {
      mismatches.push(
        `${event_type} (${label}): session_id mismatch ` +
        `(expected ${handle.slice(0, 8)}..., got ${String(rowSessionId).slice(0, 8)}...)`,
      );
    }
  }
  if (mismatches.length === 0) {
    pass(
      'C4.3 — all four lifecycle audit events link to the correct session_id ' +
      '(session_id non-null and matches originating handle for each type)',
    );
  } else {
    fail('C4.3 — lifecycle audit event session_id mismatch(es)',
         mismatches.join('; '));
  }
}

// ---------------------------------------------------------------------------
// Case 3 — C4.4: audit emission MUST NOT throw into the tool response path.
//
// C4.4's full guarantee (no-throw on a FAILED audit INSERT) requires fault
// injection that is not reachable through the MCP surface. The strongest
// observable proxy is: a successful governed call returns its result correctly
// while audit emission is active on the dispatch path.
//
// audit-never-throws is structurally enforced in logAuditEvent /
// logScopeViolation (errors are caught internally; see CLAUDE.md
// non-negotiable). A forced INSERT failure is not reachable through the MCP
// surface, so this case asserts the success-path response is correct and
// decoupled from audit emission — the observable portion of C4.4. This is NOT
// a fault-injection test; the PASS label is scoped accordingly.
// ---------------------------------------------------------------------------

console.log('[c4] Case 3 — C4.4: audit emission does not throw into tool response path\n');

{
  const hOk     = await startSession(subjectA);
  const result  = await dbReadToolRegistry(subjectA, hOk);
  const parsed  = parseToolResult(result);

  if (!result.isError && Array.isArray(parsed.rows)) {
    pass(
      'C4.4 — success-path governed call returns a real result (rows array present) ' +
      'with audit emission active on the dispatch path ' +
      '[observable proxy: not a fault-injection test; structural enforcement is in logAuditEvent]',
    );
  } else {
    fail(
      'C4.4 — success-path governed call did not return a real result',
      `isError=${result.isError}, rows=${JSON.stringify(parsed?.rows)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Case 4 — C4.5: audit trail is readable via db_read(audit_events) and is
// scope-gated.
//
// GIF-022 §C4.5 amendment candidates (spec wording discrepancies):
//   (1) No standalone "read_log" MCP tool exists — the audit-read surface is
//       db_read(table='audit_events').
//   (2) C4.5 says "admin_read action", but the implementation gates
//       audit_events behind the "read" action + "audit_events" in
//       permitted_sources. "admin_read" gates only the personas table (C6.2).
//       Both the wire name and action name in C4.5 need amendment before the
//       spec ships externally.
//
// (a) Positive assertion: auditReader (read + audit_events scope) can read
//     the audit trail via db_read(audit_events).
// (b) Gating-negative assertion: noAuditPersona (read + tool_registry ONLY,
//     NO audit_events) is denied db_read(audit_events) by the scope gate.
//     Exception 2: the noAuditPersona was inserted via admin pool in setup;
//     the assertion itself is through the MCP dispatch surface.
// ---------------------------------------------------------------------------

console.log('[c4] Case 4 — C4.5: audit trail readable via MCP surface and scope-gated\n');

// (a) Positive: auditReader can read audit_events.
{
  const read = await readAuditEvents({ event_type: 'session_start' });

  if (!read.isError && read.row_count >= 1) {
    pass(
      'C4.5 (a) — audit trail is readable via db_read(table=audit_events) ' +
      'by a persona with read + audit_events scope',
    );
  } else {
    fail(
      'C4.5 (a) — audit trail must be readable via db_read(audit_events) ' +
      'by an audit-scoped persona',
      `isError=${read.isError}, row_count=${read.row_count}`,
    );
  }
}

// (b) Gating-negative: noAuditPersona (NO audit_events in permitted_sources)
//     is denied db_read(audit_events).
{
  const result = await client.callTool({
    name: 'db_read',
    arguments: {
      persona_id:     noAuditPersonaId,
      gif_session_id: noAuditSession,
      table:          'audit_events',
      limit:          1,
    },
  });
  const parsed = parseToolResult(result);

  // The rejection MUST be an error, and the error message MUST reference the
  // scope gate (permitted_sources / audit_events / permission).
  const errorMsg = (parsed?.error ?? '') + ' ' + (parsed?.detail ?? '');
  const mentionsScope = /permitted_sources|audit_events|permission/i.test(errorMsg);

  if (result.isError === true && mentionsScope) {
    pass(
      'C4.5 (b) — db_read(audit_events) denied for persona without audit_events ' +
      'in permitted_sources (scope-gated, not free access)',
    );
  } else {
    fail(
      'C4.5 (b) — db_read(audit_events) must be denied for persona lacking audit_events scope',
      `isError=${result.isError}, error=${JSON.stringify(parsed?.error)}, detail=${JSON.stringify(parsed?.detail)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Cleanup — close the audit reader's session and noAuditSession; leave all
// other handles to TTL out (append-only convention).
//
// The noAuditPersona is NOT deleted: it minted a session and emitted a
// session_start audit event (append-only — its audit row references it).
// Leaving it in place is consistent with the leave-handles-to-TTL convention.
// It was created with TEST_TAG as created_by and a 1-hour valid_until, so it
// does not interfere with earliest-first persona discovery in future runs
// (seeded personas sort earlier by created_at).
//
// Do NOT delete subject personas (seeded, not disposable).
// ---------------------------------------------------------------------------

try {
  await client.callTool({
    name: 'session_close',
    arguments: { persona_id: auditReaderPersonaId, gif_session_id: auditReaderSession },
  });
} catch (err) {
  console.error('[c4] Cleanup warning (auditReaderSession close):', err.message);
}

try {
  await client.callTool({
    name: 'session_close',
    arguments: { persona_id: noAuditPersonaId, gif_session_id: noAuditSession },
  });
} catch (err) {
  console.error('[c4] Cleanup warning (noAuditSession close):', err.message);
}

await client.close();
await adminPool.end();
await appPool.end();

console.log(`\n[c4] Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('[c4] GIF-022 CATEGORY 4 CONFORMANCE FAILED');
  process.exit(1);
} else {
  console.log('[c4] GIF-022 Category 4 conformance passed');
}
