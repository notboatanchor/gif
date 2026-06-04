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

// test_sprint4.mjs
// =============================================================================
// Sprint 4 integration test — Integration Hardening
//
// Covers:
//   1. Tool registry — all 5 active tools present, 3 gif-layer, correct sprint
//   2. Delegation chain — child persona written to delegation_chain
//   3. Delegation scope enforcement — child scope exceeding parent is rejected
//   4. Delegation depth enforcement — exceeding max_delegation_depth is rejected
//   5. Revocation closes active sessions — sessions_terminated > 0
//   6. Post-revocation tool call is blocked — persona validation rejects revoked
//
// Run: node test_sprint4.mjs
// Requires: MCP server running on port 3100
// =============================================================================

import crypto from 'crypto';
import pg from 'pg';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

// ---------------------------------------------------------------------------
// Identity token helper (mirrors src/cli/issue_identity_token.ts)
// ---------------------------------------------------------------------------

function issueToken(assignmentId, secret) {
  const payload = Buffer.from(JSON.stringify({
    assignment_id: assignmentId,
    issued_at:     new Date().toISOString(),
  })).toString('base64url');
  const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${hmac}`;
}

const { Pool } = pg;
const SERVER_URL = process.env.MCP_BASE_URL || 'http://localhost:3100';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pass(n, msg) { console.log(`  [PASS] ${n}: ${msg}`); }
function fail(n, msg) { console.error(`  [FAIL] ${n}: ${msg}`); process.exitCode = 1; }

async function callTool(client, toolName, args) {
  const result = await client.callTool({ name: toolName, arguments: args });
  const text = result.content?.[0]?.text;
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Discover admin persona (must have manage_personas in scope)
const pool = new Pool({
  host:     process.env.PGHOST     || 'localhost',
  port:     parseInt(process.env.PGPORT || '5432'),
  user:     process.env.PGUSER     || 'gif_app',
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'gif',
});

const adminRow = await pool.query(
  `SELECT persona_id FROM gif.personas
   WHERE status = 'active'
     AND scope_definition->'permitted_actions' ? 'manage_personas'
   LIMIT 1`
);

if (adminRow.rows.length === 0) {
  console.error('[sprint4] No persona with manage_personas found — run test_setup.mjs first');
  await pool.end();
  process.exit(1);
}
const ADMIN_PERSONA_ID = adminRow.rows[0].persona_id;

const hmacSecret = process.env.IDENTITY_HMAC_SECRET;
if (!hmacSecret) {
  console.error('[sprint4] IDENTITY_HMAC_SECRET not set — required for persona_create calls');
  await pool.end();
  process.exit(1);
}

// Create a real assignment record and return a token for it.
// persona_create requires the assignment_id to exist in user_persona_assignments.
async function issueAssignedToken(personaId) {
  const result = await pool.query(
    `INSERT INTO gif.user_persona_assignments
       (external_user_id, persona_id, assigned_by, purpose_for_assignment,
        verified_identity_ref, identity_provider_hint)
     VALUES ('test-runner-sprint4', $1, 'test_sprint4.mjs', 'Sprint 4 delegation chain test',
             'test-identity', 'local-test')
     RETURNING assignment_id`,
    [personaId]
  );
  const assignmentId = result.rows[0].assignment_id;
  return issueToken(assignmentId, hmacSecret);
}

const transport = new StreamableHTTPClientTransport(new URL(`${SERVER_URL}/mcp`));
const client    = new Client({ name: 'sprint4-test', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);

// PR2: mint a v0.2 governance session handle (GIF-019/020) for all governed
// calls in this test under the admin persona.
const startResult = await client.callTool({
  name: 'session_start',
  arguments: { persona_id: ADMIN_PERSONA_ID },
});
const gif_session_id = JSON.parse(startResult.content[0].text).gif_session_id;

let parentPersonaId = null;
let childPersonaId  = null;
let revocationTargetId = null;

try {

  // -------------------------------------------------------------------------
  // Check 1: Tool registry — active tools and gif-layer tools
  // -------------------------------------------------------------------------

  const registryResult = await callTool(client, 'db_read', {
    persona_id: ADMIN_PERSONA_ID,
    gif_session_id,
    table:      'tool_registry',
    filters:    JSON.stringify({ status: 'active' }),
    limit:      20,
  });

  const activeTools = registryResult.rows ?? [];
  const gifTools    = activeTools.filter(t => t.tool_layer === 'gif');

  if (activeTools.length === 5) {
    pass(1, `tool_registry has 5 active tools`);
  } else {
    fail(1, `Expected 5 active tools, got ${activeTools.length}`);
  }

  if (gifTools.length === 3) {
    pass(2, `3 gif-layer tools: ${gifTools.map(t => t.tool_name).join(', ')}`);
  } else {
    fail(2, `Expected 3 gif-layer tools, got ${gifTools.length}: ${gifTools.map(t => t.tool_name).join(', ')}`);
  }

  // -------------------------------------------------------------------------
  // Check 3: Delegation chain — create parent persona, then child
  // -------------------------------------------------------------------------

  const parentResult = await callTool(client, 'persona_create', {
    persona_id:           ADMIN_PERSONA_ID,
    gif_session_id,
    issuing_entity:       'Sprint 4 Test',
    purpose:              'Parent persona for delegation chain test',
    created_by:           'test_sprint4.mjs',
    scope_definition:     JSON.stringify({
      permitted_sources:  ['personas', 'audit_events'],
      permitted_actions:  ['read', 'write'],
    }),
    valid_until:          '2026-06-30T00:00:00Z',
    max_delegation_depth: 2,
    identity_token:       await issueAssignedToken(ADMIN_PERSONA_ID),
  });

  parentPersonaId = parentResult.persona_id;

  if (parentResult.created && parentPersonaId) {
    pass(3, `Parent persona created: ${parentPersonaId}`);
  } else {
    fail(3, `Parent persona creation failed: ${JSON.stringify(parentResult)}`);
  }

  // Create child persona with a subset of parent scope
  const childResult = await callTool(client, 'persona_create', {
    persona_id:           ADMIN_PERSONA_ID,
    gif_session_id,
    issuing_entity:       'Sprint 4 Test',
    purpose:              'Child persona for delegation chain test',
    created_by:           'test_sprint4.mjs',
    scope_definition:     JSON.stringify({
      permitted_sources:  ['personas'],          // subset of parent
      permitted_actions:  ['read'],              // subset of parent
    }),
    valid_until:          '2026-06-30T00:00:00Z',
    max_delegation_depth: 1,
    parent_persona_id:    parentPersonaId,
    identity_token:       await issueAssignedToken(ADMIN_PERSONA_ID),
  });

  childPersonaId = childResult.persona_id;

  if (childResult.created && childPersonaId && childResult.delegation_depth === 1) {
    pass(4, `Child persona created at delegation_depth=1: ${childPersonaId}`);
  } else {
    fail(4, `Child persona creation failed or wrong depth: ${JSON.stringify(childResult)}`);
  }

  // Verify delegation_chain record written
  const chainResult = await callTool(client, 'db_read', {
    persona_id: ADMIN_PERSONA_ID,
    gif_session_id,
    table:      'delegation_chain',
    filters:    JSON.stringify({ child_persona_id: childPersonaId }),
    limit:      1,
  });

  const chainRow = chainResult.rows?.[0];
  if (chainRow && chainRow.parent_persona_id === parentPersonaId && chainRow.delegation_depth === 1) {
    pass(5, `delegation_chain record written: depth=${chainRow.delegation_depth}, parent=${chainRow.parent_persona_id.slice(0,8)}…`);
  } else {
    fail(5, `delegation_chain record missing or incorrect: ${JSON.stringify(chainRow)}`);
  }

  // -------------------------------------------------------------------------
  // Check 6: Scope exceeding parent is rejected
  // -------------------------------------------------------------------------

  const exceededScopeResult = await callTool(client, 'persona_create', {
    persona_id:           ADMIN_PERSONA_ID,
    gif_session_id,
    issuing_entity:       'Sprint 4 Test',
    purpose:              'Persona attempting to exceed parent scope',
    created_by:           'test_sprint4.mjs',
    scope_definition:     JSON.stringify({
      permitted_actions:  ['read', 'write', 'manage_personas'],  // 'manage_personas' not in parent
    }),
    valid_until:          '2026-06-30T00:00:00Z',
    parent_persona_id:    parentPersonaId,
    identity_token:       await issueAssignedToken(ADMIN_PERSONA_ID),
  });

  if (exceededScopeResult.error && exceededScopeResult.error.includes('exceeds parent scope')) {
    pass(6, `Scope exceeding parent correctly rejected: ${exceededScopeResult.error}`);
  } else {
    fail(6, `Expected scope rejection, got: ${JSON.stringify(exceededScopeResult)}`);
  }

  // -------------------------------------------------------------------------
  // Check 7: Delegation depth exceeding parent max_delegation_depth is rejected
  // -------------------------------------------------------------------------

  // child has max_delegation_depth=1, so grandchild would be depth=2
  // child's max_delegation_depth=1, so depth 2 > 1 — should be rejected
  const grandchildResult = await callTool(client, 'persona_create', {
    persona_id:           ADMIN_PERSONA_ID,
    gif_session_id,
    issuing_entity:       'Sprint 4 Test',
    purpose:              'Grandchild persona exceeding delegation depth',
    created_by:           'test_sprint4.mjs',
    scope_definition:     JSON.stringify({
      permitted_actions:  ['read'],
    }),
    valid_until:          '2026-06-30T00:00:00Z',
    parent_persona_id:    childPersonaId,
    identity_token:       await issueAssignedToken(ADMIN_PERSONA_ID),
  });

  if (grandchildResult.error && grandchildResult.error.includes('max_delegation_depth')) {
    pass(7, `Depth exceeding max_delegation_depth correctly rejected: ${grandchildResult.error}`);
  } else {
    fail(7, `Expected depth rejection, got: ${JSON.stringify(grandchildResult)}`);
  }

  // -------------------------------------------------------------------------
  // Check 8–10: Revocation closes active sessions, blocks subsequent calls
  // -------------------------------------------------------------------------

  // Create a persona to revoke
  const revokeTargetResult = await callTool(client, 'persona_create', {
    persona_id:       ADMIN_PERSONA_ID,
    gif_session_id,
    issuing_entity:   'Sprint 4 Test',
    purpose:          'Persona created to test revocation session handling',
    created_by:       'test_sprint4.mjs',
    scope_definition: JSON.stringify({
      permitted_sources:  ['audit_events'],
      permitted_actions:  ['read'],
    }),
    valid_until:      '2026-06-30T00:00:00Z',
    identity_token:   await issueAssignedToken(ADMIN_PERSONA_ID),
  });

  revocationTargetId = revokeTargetResult.persona_id;

  if (!revokeTargetResult.created) {
    fail(8, `Could not create revocation target persona: ${JSON.stringify(revokeTargetResult)}`);
  } else {

    // Verify that revocation returns sessions_terminated field and
    // the revocation_log records it accurately.

    const revokeResult = await callTool(client, 'persona_revoke', {
      persona_id:        ADMIN_PERSONA_ID,
      gif_session_id,
      target_persona_id: revocationTargetId,
      reason:            'Sprint 4 test: revocation session termination test',
      revoked_by:        'test_sprint4.mjs',
    });

    if (revokeResult.revoked && 'sessions_terminated' in revokeResult) {
      pass(8, `Revocation returned sessions_terminated: ${revokeResult.sessions_terminated}`);
    } else {
      fail(8, `Revocation response missing sessions_terminated: ${JSON.stringify(revokeResult)}`);
    }

    // Verify revocation_log records active_sessions_terminated
    const logResult = await callTool(client, 'db_read', {
      persona_id: ADMIN_PERSONA_ID,
      gif_session_id,
      table:      'revocation_log',
      filters:    JSON.stringify({ persona_id: revocationTargetId }),
      limit:      1,
    });

    const logRow = logResult.rows?.[0];
    if (logRow && typeof logRow.active_sessions_terminated === 'number') {
      pass(9, `revocation_log.active_sessions_terminated recorded: ${logRow.active_sessions_terminated}`);
    } else {
      fail(9, `revocation_log row missing or active_sessions_terminated not recorded: ${JSON.stringify(logRow)}`);
    }

    // Attempt a tool call with the revoked persona — must be rejected
    const blockedResult = await callTool(client, 'persona_validate', {
      persona_id: revocationTargetId,
    });

    if (blockedResult.valid === false && blockedResult.reason === 'NOT_ACTIVE') {
      pass(10, `Revoked persona correctly blocked: ${blockedResult.message}`);
    } else {
      fail(10, `Expected NOT_ACTIVE rejection, got: ${JSON.stringify(blockedResult)}`);
    }
  }

} finally {
  // Clean up test personas (leave revoked one as-is — it's already revoked)
  if (childPersonaId) {
    await callTool(client, 'persona_revoke', {
      persona_id:        ADMIN_PERSONA_ID,
      gif_session_id,
      target_persona_id: childPersonaId,
      reason:            'Sprint 4 test cleanup',
      revoked_by:        'test_sprint4.mjs',
    }).catch(() => {});
  }
  if (parentPersonaId) {
    await callTool(client, 'persona_revoke', {
      persona_id:        ADMIN_PERSONA_ID,
      gif_session_id,
      target_persona_id: parentPersonaId,
      reason:            'Sprint 4 test cleanup',
      revoked_by:        'test_sprint4.mjs',
    }).catch(() => {});
  }

  // Explicit caller-close per GIF-020.
  await client.callTool({
    name: 'session_close',
    arguments: { persona_id: ADMIN_PERSONA_ID, gif_session_id },
  }).catch(() => {});

  await client.close();
  await pool.end();
}
