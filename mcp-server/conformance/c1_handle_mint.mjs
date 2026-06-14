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

// conformance/c1_handle_mint.mjs
// =============================================================================
// GIF-022 Category 1 — Handle minting conformance scenarios.
//
// Asserts the C1.1–C1.6 MUSTs in GIF-022 §Conformance-Required Behaviors
// against a running gif MCP server. This is the first conformance scenario;
// the harness conventions established here are pattern-and-paste templates
// for c2_*.mjs through c6_*.mjs.
//
// Discipline (load-bearing for the conformance contract):
//   - Setup uses the admin pool to seed personas only. No assertion reads
//     the database directly. Every conformance assertion routes through the
//     three MCP surfaces enumerated in GIF-022 §What a Conformance Harness
//     Needs to Introspect: tools/list, tool dispatch, db_read on audit_events.
//   - "read_log" in GIF-022 terminology is db_read(table='audit_events')
//     gated by the admin-read / audit-events read scope. There is no
//     standalone read_log tool.
//   - Case labels carry the MUST IDs (C1.1, C1.2, ...) for direct trace to
//     GIF-022. Scenario files live under mcp-server/conformance/ so the
//     subtree extracts cleanly to a future gif-spec repository post-v0.2.0.
//
// Cases:
//   1. C1.1 — session_start is discoverable via tools/list.
//   2. C1.2 — session_start.inputSchema.required includes persona_id (string).
//   3. C1.3 + C1.4 — approved-persona mint returns a gif_session_id string,
//      and two consecutive mints return distinct handles (uniqueness witness).
//   4. C1.5 — exactly one session_start audit event is linked to the new
//      session_id, read back through db_read on audit_events.
//   5. C1.6 — non-approved persona is rejected via the documented
//      PersonaInvalidReason surface, and no session_start audit event is
//      emitted for that persona.
//
// Requires: MCP server running on port 3100, test_setup.mjs run first.
// Run from gif/mcp-server/:
//   npm run build && node conformance/c1_handle_mint.mjs
// =============================================================================

import pg from 'pg';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Admin pool — used ONLY to seed personas (C1.6 unapproved persona) and to
// clean them up at the end. No conformance assertion reads from this pool.
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
  { name: 'gif-conformance-c1', version: '0.1.0' },
  { capabilities: {} },
);
await client.connect(transport);

console.log('\n[c1] GIF-022 Category 1 — Handle Minting\n');

// ---------------------------------------------------------------------------
// Setup — discover approved personas seeded by test_setup.mjs.
//
// Mint subject:   persona with read+write+manage_personas scope (persona #1).
// Audit reader:   persona with read scope on audit_events (persona #2). The
//                 reader needs its own gif_session_id since db_read is a
//                 governed tool per GIF-019.
// Unapproved:     freshly inserted via admin pool with governance_review_status
//                 = 'pending'. Cleaned up at end.
// ---------------------------------------------------------------------------

const TEST_TAG = `c1_handle_mint_${Date.now()}`;

let mintSubjectPersonaId;
let auditReaderPersonaId;
let unapprovedPersonaId;

try {
  // Mint subject: any approved persona will do. Use the one seeded for
  // sprint 3/4 (broad scope, won't collide with the audit reader).
  const mintSubjectResult = await adminPool.query(
    `SELECT persona_id FROM gif.personas
      WHERE status = 'active' AND governance_review_status = 'approved'
        AND scope_definition::jsonb -> 'permitted_actions' ? 'write'
      ORDER BY created_at
      LIMIT 1`,
  );
  if (mintSubjectResult.rows.length !== 1) {
    throw new Error('No approved write-scoped persona found — run test_setup.mjs first');
  }
  mintSubjectPersonaId = mintSubjectResult.rows[0].persona_id;

  // Audit reader: persona with read + audit_events scope.
  const auditReaderResult = await adminPool.query(
    `SELECT persona_id FROM gif.personas
      WHERE status = 'active' AND governance_review_status = 'approved'
        AND scope_definition::jsonb -> 'permitted_actions' ? 'read'
        AND scope_definition::jsonb -> 'permitted_sources' ? 'audit_events'
      ORDER BY created_at
      LIMIT 1`,
  );
  if (auditReaderResult.rows.length !== 1) {
    throw new Error('No persona with read+audit_events scope found — run test_setup.mjs first');
  }
  auditReaderPersonaId = auditReaderResult.rows[0].persona_id;

  // Unapproved persona: created here so the test owns the lifecycle.
  // governance_review_status = 'pending' is the path C1.6 covers.
  const unapprovedResult = await adminPool.query(
    `INSERT INTO gif.personas
       (issuing_entity, purpose, created_by, scope_definition, valid_until,
        status, governance_review_status)
     VALUES (
       'conformance-c1',
       'C1.6 unapproved-persona rejection scenario',
       $1,
       '{"permitted_actions":["read"],"permitted_sources":["audit_events"],"max_results":1}'::jsonb,
       now() + interval '1 hour',
       'active',
       'pending'
     )
     RETURNING persona_id`,
    [TEST_TAG],
  );
  unapprovedPersonaId = unapprovedResult.rows[0].persona_id;

  console.log(
    `[c1] Setup: mint_subject=${mintSubjectPersonaId.slice(0, 8)}..., ` +
    `audit_reader=${auditReaderPersonaId.slice(0, 8)}..., ` +
    `unapproved=${unapprovedPersonaId.slice(0, 8)}...\n`,
  );
} catch (err) {
  console.error('[c1] Setup failed:', err.message);
  await client.close().catch(() => {});
  await adminPool.end();
  process.exit(1);
}

// Mint a session for the audit reader once — reused across case 4 and case 5.
let auditReaderSession;
{
  const result = await client.callTool({
    name: 'session_start',
    arguments: { persona_id: auditReaderPersonaId },
  });
  auditReaderSession = parseToolResult(result).gif_session_id;
}

// ---------------------------------------------------------------------------
// Case 1 — C1.1: session_start is exposed via tools/list.
// ---------------------------------------------------------------------------

const toolList = await client.listTools();
const sessionStartDef = toolList.tools.find(t => t.name === 'session_start');

if (sessionStartDef) {
  pass('C1.1 — session_start is discoverable via tools/list');
} else {
  fail('C1.1 — session_start must appear in tools/list',
       `tools returned: ${toolList.tools.map(t => t.name).join(', ')}`);
}

// ---------------------------------------------------------------------------
// Case 2 — C1.2: session_start.inputSchema.required includes persona_id and
// the field is typed as a string.
// ---------------------------------------------------------------------------

if (!sessionStartDef) {
  fail('C1.2 — cannot evaluate without C1.1');
} else {
  const required   = sessionStartDef.inputSchema?.required ?? [];
  const personaDef = sessionStartDef.inputSchema?.properties?.persona_id;
  const requiredOk = Array.isArray(required) && required.includes('persona_id');
  const stringOk   = personaDef?.type === 'string';

  if (requiredOk && stringOk) {
    pass('C1.2 — session_start.inputSchema.required includes persona_id (string)');
  } else {
    fail('C1.2 — session_start must require persona_id as a string field',
         `required=${JSON.stringify(required)}, persona_id.type=${personaDef?.type}`);
  }
}

// ---------------------------------------------------------------------------
// Case 3 — C1.3 + C1.4: an approved-persona mint returns a gif_session_id
// string, and two consecutive mints return distinct handles (uniqueness
// witness — C1.4 requires "unique across the implementation's session
// history; MUST identify exactly one session row").
// ---------------------------------------------------------------------------

let mintedSessionId;
{
  const first = await client.callTool({
    name: 'session_start',
    arguments: {
      persona_id:         mintSubjectPersonaId,
      invocation_context: { conformance: 'c1.3-c1.4', case: 'first-mint' },
    },
  });
  const firstParsed = parseToolResult(first);

  if (first.isError) {
    fail('C1.3/C1.4 — approved-persona mint must not error',
         JSON.stringify(firstParsed));
  } else if (typeof firstParsed.gif_session_id !== 'string' ||
             firstParsed.gif_session_id.length === 0) {
    fail('C1.3/C1.4 — response must include gif_session_id as a non-empty string',
         JSON.stringify(firstParsed));
  } else {
    mintedSessionId = firstParsed.gif_session_id;

    const second = await client.callTool({
      name: 'session_start',
      arguments: {
        persona_id:         mintSubjectPersonaId,
        invocation_context: { conformance: 'c1.3-c1.4', case: 'second-mint' },
      },
    });
    const secondParsed = parseToolResult(second);

    if (second.isError ||
        typeof secondParsed.gif_session_id !== 'string' ||
        secondParsed.gif_session_id.length === 0) {
      fail('C1.4 — second mint must also return a gif_session_id string',
           JSON.stringify(secondParsed));
    } else if (secondParsed.gif_session_id === mintedSessionId) {
      fail('C1.4 — consecutive mints must produce distinct handles',
           `both returned ${mintedSessionId}`);
    } else {
      pass(`C1.3 / C1.4 — mint returns distinct gif_session_id strings ` +
           `(${mintedSessionId.slice(0, 8)}..., ${secondParsed.gif_session_id.slice(0, 8)}...)`);
    }
  }
}

// ---------------------------------------------------------------------------
// Case 4 — C1.5: exactly one session_start audit event linked to the new
// session_id, observed through the read_log surface (db_read on
// audit_events). The read uses the audit reader's own session handle.
// ---------------------------------------------------------------------------

if (!mintedSessionId) {
  fail('C1.5 — cannot evaluate without C1.3/C1.4');
} else {
  // Tiny delay for the fire-and-forget audit insert in session_start to land.
  await new Promise(r => setTimeout(r, 200));

  const readResult = await client.callTool({
    name: 'db_read',
    arguments: {
      persona_id:     auditReaderPersonaId,
      gif_session_id: auditReaderSession,
      table:          'audit_events',
      filters:        JSON.stringify({
        session_id: mintedSessionId,
        event_type: 'session_start',
      }),
      limit:          10,
    },
  });
  const readParsed = parseToolResult(readResult);

  if (readResult.isError) {
    fail('C1.5 — db_read on audit_events must succeed for an audit-reader persona',
         JSON.stringify(readParsed));
  } else if (readParsed.row_count !== 1) {
    fail('C1.5 — exactly one session_start audit event must link to the new session_id',
         `row_count=${readParsed.row_count}`);
  } else {
    const row = readParsed.rows[0];
    if (row.event_type !== 'session_start' || row.outcome !== 'allowed') {
      fail('C1.5 — audit event must be session_start / allowed',
           `got event_type=${row.event_type}, outcome=${row.outcome}`);
    } else {
      pass('C1.5 — exactly one session_start audit event linked to the new session_id');
    }
  }
}

// ---------------------------------------------------------------------------
// Case 5 — C1.6: a failing session_start (persona not approved) returns the
// documented PersonaInvalidReason surface and emits NO session_start audit
// event for that persona. The "no audit" assertion uses the audit-reader
// session to query audit_events filtered by the unapproved persona's id;
// the unapproved persona is freshly minted in setup, so a zero-row result
// is the unambiguous "no session_start emitted" signal.
// ---------------------------------------------------------------------------

{
  const rejected = await client.callTool({
    name: 'session_start',
    arguments: { persona_id: unapprovedPersonaId },
  });
  const rejectedParsed = parseToolResult(rejected);

  const rejectedOk =
    rejected.isError === true &&
    rejectedParsed.valid === false &&
    rejectedParsed.reason === 'GOVERNANCE_REVIEW_REQUIRED';

  if (!rejectedOk) {
    fail('C1.6 — unapproved persona must reject with GOVERNANCE_REVIEW_REQUIRED',
         JSON.stringify(rejectedParsed));
  } else {
    // Verify no session_start audit event landed for the unapproved persona.
    await new Promise(r => setTimeout(r, 200));

    const readResult = await client.callTool({
      name: 'db_read',
      arguments: {
        persona_id:     auditReaderPersonaId,
        gif_session_id: auditReaderSession,
        table:          'audit_events',
        filters:        JSON.stringify({
          persona_id: unapprovedPersonaId,
          event_type: 'session_start',
        }),
        limit:          10,
      },
    });
    const readParsed = parseToolResult(readResult);

    if (readResult.isError) {
      fail('C1.6 — db_read on audit_events must succeed when checking no-emit',
           JSON.stringify(readParsed));
    } else if (readParsed.row_count !== 0) {
      fail('C1.6 — no session_start audit event may exist for the rejected persona',
           `row_count=${readParsed.row_count}`);
    } else {
      pass('C1.6 — unapproved persona rejected (GOVERNANCE_REVIEW_REQUIRED); ' +
           'no session_start audit emitted');
    }
  }
}

// ---------------------------------------------------------------------------
// Cleanup — close the audit reader's session and delete the unapproved
// persona. Sessions minted in case 3 are left to TTL out (matches existing
// test-suite convention); they carry a `conformance` marker in
// invocation_context for traceability.
// ---------------------------------------------------------------------------

try {
  await client.callTool({
    name: 'session_close',
    arguments: { persona_id: auditReaderPersonaId, gif_session_id: auditReaderSession },
  });
} catch (err) {
  console.error('[c1] Cleanup warning (session_close):', err.message);
}

try {
  // No FK references possible — the unapproved persona never minted a session
  // and never produced an audit event (C1.6 asserts both).
  await adminPool.query(
    `DELETE FROM gif.personas WHERE created_by = $1`,
    [TEST_TAG],
  );
} catch (err) {
  console.error('[c1] Cleanup warning (persona delete):', err.message);
}

await client.close();
await adminPool.end();

console.log(`\n[c1] Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('[c1] GIF-022 CATEGORY 1 CONFORMANCE FAILED');
  process.exit(1);
} else {
  console.log('[c1] GIF-022 Category 1 conformance passed');
}
