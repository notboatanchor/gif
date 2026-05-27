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

// conformance/c6_identity_gates.mjs
// =============================================================================
// GIF-022 Category 6 — Identity and provisioning gates conformance scenarios.
//
// Asserts the C6.1–C6.3 MUSTs in GIF-022 §Conformance-Required Behaviors
// against a running gif MCP server.
//
// Discipline (load-bearing for the conformance contract):
//   - Default rule: admin pool for setup only (seeding the three disposable
//     personas + the one C6.3 governance-status flip). Every conformance
//     assertion routes through the MCP surfaces in GIF-022 §What a Conformance
//     Harness Needs to Introspect. C6 exercises two of the three surfaces:
//       * tools/list        — C6.1 (persona_create schema)
//       * tool dispatch      — C6.2 (db_read on personas, allowed only via
//                              admin_read) and C6.3 (governed dispatch rejected
//                              for a non-approved persona).
//     The audit_events read surface is not needed for these MUSTs.
//   - Case labels carry the MUST IDs (C6.1–C6.3) for direct trace to GIF-022.
//     Scenario files live under mcp-server/conformance/ so the subtree extracts
//     cleanly to a future gif-spec repository post-v0.2.0.
//
// Cases:
//   1. C6.1 — persona_create is discoverable via tools/list AND its
//      inputSchema.required includes identity_token (string).
//   2. C6.2 — the personas table is reachable from MCP ONLY through the
//      admin_read action:
//        (a) positive — a persona with admin_read + personas-in-sources reads
//            personas successfully.
//        (b) negative — a persona with the generic read action (and personas
//            present in permitted_sources) is DENIED. The negative deliberately
//            puts `personas` in permitted_sources so the denial isolates the
//            admin_read *action* gate, not the source allowlist — proving the
//            table is not reachable via generic read.
//   3. C6.3 — dispatch rejects any persona with
//      governance_review_status != 'approved'. Isolated from C1.6 (which covers
//      the mint-time session_start path): a persona is minted while approved,
//      then flipped to a non-approved status, then a GOVERNED dispatch is
//      attempted on the still-valid handle. A before/after delta witnesses that
//      the governance flip — re-validated at dispatch (index.ts validatePersona
//      runs on every tool call before session validation) — is the cause.
//
// Implementation note (latent type/DB drift, logged here — NOT a C6 conformance
// issue): the TypeScript GovernanceReviewStatus type (enforcement.ts) enumerates
// 'revoked' and 'auto_approved' in addition to 'pending'/'approved', but the DB
// ENUM governance_review_status (schema/001_gif_core.sql) defines only
// 'auto_approved' | 'pending' | 'approved'. C6.3 flips to 'pending' (DB-valid,
// != 'approved'); the gate (enforcement.ts: `!== 'approved'`) treats every
// non-'approved' value identically, so the MUST is exercised regardless. The
// type-vs-DB drift is worth a separate cleanup but does not affect conformance.
//
// Requires: MCP server running on port 3100; test_setup.mjs run first (provides
// the schema, the gif_admin role, and the issue path). C6 seeds its own
// disposable personas, so it does not depend on which personas test_setup
// created.
// Run from gif/mcp-server/:
//   npm run build && node conformance/c6_identity_gates.mjs
// =============================================================================

import pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Admin pool — used ONLY for setup: seeding the three disposable personas and
// performing the single C6.3 governance-status flip. No conformance assertion
// reads from this pool.
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
  { name: 'gif-conformance-c6', version: '0.1.0' },
  { capabilities: {} },
);
await client.connect(transport);

console.log('\n[c6] GIF-022 Category 6 — Identity and Provisioning Gates\n');

// ---------------------------------------------------------------------------
// Setup — seed three disposable personas via the admin pool. All are
// approved + active with a 1-hour valid_until and created_by = TEST_TAG so
// they are unambiguously this run's and do not interfere with persona
// discovery in other scenarios.
//
// adminReaderPersona — read + admin_read action, personas in permitted_sources.
//   C6.2(a) positive: can read the personas table.
// nonAdminPersona    — read action ONLY (no admin_read); personas AND
//   tool_registry in permitted_sources. C6.2(b) negative: denied personas even
//   though personas is in permitted_sources — isolates the admin_read action
//   gate.
// revocablePersona   — read action, tool_registry in permitted_sources. C6.3:
//   minted while approved, flipped to non-approved, then dispatched against.
//
// None of these is deleted at cleanup: each mints a session (and emits a
// session_start audit event), so the append-only audit trail references them.
// This matches c4's noAuditPersona convention.
// ---------------------------------------------------------------------------

const TEST_TAG = `c6_identity_gates_${Date.now()}`;

let adminReaderPersonaId;
let nonAdminPersonaId;
let revocablePersonaId;

async function seedPersona(purpose, scopeJson) {
  const result = await adminPool.query(
    `INSERT INTO gif.personas
       (issuing_entity, purpose, created_by, scope_definition, valid_until,
        status, governance_review_status)
     VALUES (
       'conformance-c6',
       $1,
       $2,
       $3::jsonb,
       now() + interval '1 hour',
       'active',
       'approved'
     )
     RETURNING persona_id`,
    [purpose, TEST_TAG, scopeJson],
  );
  return result.rows[0].persona_id;
}

try {
  adminReaderPersonaId = await seedPersona(
    'C6.2(a) admin_read positive scenario',
    '{"permitted_actions":["read","admin_read"],"permitted_sources":["personas"],"max_results":5}',
  );
  nonAdminPersonaId = await seedPersona(
    'C6.2(b) generic-read gating-negative scenario',
    '{"permitted_actions":["read"],"permitted_sources":["personas","tool_registry"],"max_results":5}',
  );
  revocablePersonaId = await seedPersona(
    'C6.3 dispatch governance-gate scenario',
    '{"permitted_actions":["read"],"permitted_sources":["tool_registry"],"max_results":5}',
  );

  console.log(
    `[c6] Setup: adminReader=${adminReaderPersonaId.slice(0, 8)}..., ` +
    `nonAdmin=${nonAdminPersonaId.slice(0, 8)}..., ` +
    `revocable=${revocablePersonaId.slice(0, 8)}...\n`,
  );
} catch (err) {
  console.error('[c6] Setup failed:', err.message);
  await client.close().catch(() => {});
  await adminPool.end();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function startSession(personaId, caseTag) {
  const r = await client.callTool({
    name: 'session_start',
    arguments: {
      persona_id:         personaId,
      invocation_context: { conformance: 'c6', case: caseTag },
    },
  });
  return parseToolResult(r).gif_session_id;
}

async function dbRead(personaId, gifSessionId, table) {
  return client.callTool({
    name: 'db_read',
    arguments: {
      persona_id:     personaId,
      gif_session_id: gifSessionId,
      table,
      limit:          5,
    },
  });
}

// Mint the sessions used across the cases. revocableSession is minted now,
// while revocablePersona is still approved — C6.3 depends on this ordering.
const adminReaderSession = await startSession(adminReaderPersonaId, 'c6.2a');
const nonAdminSession    = await startSession(nonAdminPersonaId,    'c6.2b');
const revocableSession   = await startSession(revocablePersonaId,   'c6.3');

// ---------------------------------------------------------------------------
// Case 1 — C6.1: persona_create requires identity_token in inputSchema.required.
// ---------------------------------------------------------------------------

console.log('[c6] Case 1 — C6.1: persona_create requires identity_token\n');

{
  const toolList          = await client.listTools();
  const personaCreateDef  = toolList.tools.find(t => t.name === 'persona_create');

  if (!personaCreateDef) {
    fail('C6.1 — persona_create must appear in tools/list',
         `tools returned: ${toolList.tools.map(t => t.name).join(', ')}`);
  } else {
    const required   = personaCreateDef.inputSchema?.required ?? [];
    const tokenDef   = personaCreateDef.inputSchema?.properties?.identity_token;
    const requiredOk = Array.isArray(required) && required.includes('identity_token');
    const stringOk   = tokenDef?.type === 'string';

    if (requiredOk && stringOk) {
      pass('C6.1 — persona_create.inputSchema.required includes identity_token (string)');
    } else {
      fail('C6.1 — persona_create must require identity_token as a string field',
           `required=${JSON.stringify(required)}, identity_token.type=${tokenDef?.type}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Case 2 — C6.2: personas reachable from MCP ONLY through the admin_read action.
// ---------------------------------------------------------------------------

console.log('[c6] Case 2 — C6.2: personas reachable only via admin_read\n');

// (a) Positive: adminReaderPersona (admin_read + personas source) reads personas.
{
  const result = await dbRead(adminReaderPersonaId, adminReaderSession, 'personas');
  const parsed = parseToolResult(result);

  if (!result.isError && Array.isArray(parsed.rows) && parsed.row_count >= 1) {
    pass('C6.2 (a) — personas is readable via db_read by a persona with the ' +
         'admin_read action (personas in permitted_sources)');
  } else {
    fail('C6.2 (a) — personas must be readable via db_read for an admin_read persona',
         `isError=${result.isError}, row_count=${parsed.row_count}, error=${JSON.stringify(parsed.error)}`);
  }
}

// (b) Negative: nonAdminPersona (generic read action only; personas IS in
//     permitted_sources) is denied — proving the admin_read *action* gate, not
//     just the source allowlist, governs the personas table.
{
  const result = await dbRead(nonAdminPersonaId, nonAdminSession, 'personas');
  const parsed = parseToolResult(result);

  // The scope error message names the missing admin_read action.
  const mentionsAdminRead = /admin_read|permitted_actions/i.test(parsed?.error ?? '');

  if (result.isError === true && mentionsAdminRead) {
    pass('C6.2 (b) — personas denied to a persona with generic read but no ' +
         'admin_read action (even with personas in permitted_sources) — ' +
         'not freely readable');
  } else {
    fail('C6.2 (b) — personas must be denied to a persona lacking the admin_read action',
         `isError=${result.isError}, error=${JSON.stringify(parsed?.error)}`);
  }
}

// ---------------------------------------------------------------------------
// Case 3 — C6.3: dispatch rejects any persona with
// governance_review_status != 'approved'.
//
// Distinct from C1.6 (mint-time session_start rejection). Here the persona is
// approved at mint, mints a valid session, then is flipped to a non-approved
// status. A subsequent GOVERNED dispatch on the still-valid handle must be
// rejected — validatePersona runs on every tool call (index.ts) before session
// validation, so the governance gate is re-checked at dispatch.
//
// before-flip success + after-flip rejection is the delta that isolates the
// governance flip as the cause (the handle and scope are otherwise unchanged).
// ---------------------------------------------------------------------------

console.log('[c6] Case 3 — C6.3: dispatch rejects non-approved persona\n');

{
  // Before flip: governed dispatch succeeds (witness).
  const before       = await dbRead(revocablePersonaId, revocableSession, 'tool_registry');
  const beforeParsed = parseToolResult(before);
  const beforeOk     = !before.isError && Array.isArray(beforeParsed.rows);

  if (!beforeOk) {
    fail('C6.3 — pre-flip governed dispatch must succeed (witness for the delta)',
         `isError=${before.isError}, error=${JSON.stringify(beforeParsed.error)}`);
  } else {
    // Flip governance_review_status to a non-approved value (admin pool, setup-
    // only mutation). 'pending' is DB-valid and != 'approved'.
    await adminPool.query(
      `UPDATE gif.personas
          SET governance_review_status = 'pending'
        WHERE persona_id = $1`,
      [revocablePersonaId],
    );
    // Tiny delay so the committed flip is visible to the server's pool.
    await new Promise(r => setTimeout(r, 200));

    // After flip: same persona, same valid handle, same scope — must reject.
    const after       = await dbRead(revocablePersonaId, revocableSession, 'tool_registry');
    const afterParsed = parseToolResult(after);

    const afterRejected =
      after.isError === true &&
      afterParsed.valid === false &&
      afterParsed.reason === 'GOVERNANCE_REVIEW_REQUIRED';

    if (afterRejected) {
      pass('C6.3 — governed dispatch rejected (GOVERNANCE_REVIEW_REQUIRED) once the ' +
           'persona is non-approved, though the same call succeeded while approved');
    } else {
      fail('C6.3 — governed dispatch must reject a non-approved persona at dispatch time',
           `isError=${after.isError}, valid=${afterParsed.valid}, reason=${afterParsed.reason}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Cleanup — close the two healthy sessions. revocableSession is left to TTL:
// its persona is now non-approved, so session_close (which also routes through
// validatePersona at dispatch) would itself be rejected — leaving the handle
// to lazy TTL expiry is the append-only-consistent path.
//
// The three disposable personas are NOT deleted: each minted a session and
// emitted a session_start audit event (append-only references). They carry
// created_by = TEST_TAG and a 1-hour valid_until, so they do not interfere with
// other scenarios' persona discovery (issuing_entity = 'conformance-c6').
// ---------------------------------------------------------------------------

for (const [personaId, session, label] of [
  [adminReaderPersonaId, adminReaderSession, 'adminReaderSession'],
  [nonAdminPersonaId,    nonAdminSession,    'nonAdminSession'],
]) {
  try {
    await client.callTool({
      name: 'session_close',
      arguments: { persona_id: personaId, gif_session_id: session },
    });
  } catch (err) {
    console.error(`[c6] Cleanup warning (${label} close):`, err.message);
  }
}

await client.close();
await adminPool.end();

console.log(`\n[c6] Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('[c6] GIF-022 CATEGORY 6 CONFORMANCE FAILED');
  process.exit(1);
} else {
  console.log('[c6] GIF-022 Category 6 conformance passed');
}
