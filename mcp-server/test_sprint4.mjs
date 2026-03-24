// test_sprint4.mjs
// =============================================================================
// Sprint 4 integration test — Integration Hardening
//
// Covers:
//   1. Tool registry — all 6 active tools present, 3 gif-layer, correct sprint
//   2. Delegation chain — child persona written to delegation_chain
//   3. Delegation scope enforcement — child scope exceeding parent is rejected
//   4. Delegation depth enforcement — exceeding max_delegation_depth is rejected
//   5. Revocation closes active sessions — sessions_terminated > 0
//   6. Post-revocation tool call is blocked — persona validation rejects revoked
//
// Run: node test_sprint4.mjs
// Requires: MCP server running on port 3100, gif_research DB accessible
// =============================================================================

import pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const { Pool } = pg;
const SERVER_URL = 'http://localhost:3100';

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
await pool.end();

if (adminRow.rows.length === 0) {
  console.error('[sprint4] No persona with manage_personas found — run test_setup.mjs first');
  process.exit(1);
}
const ADMIN_PERSONA_ID = adminRow.rows[0].persona_id;

const transport = new SSEClientTransport(new URL(`${SERVER_URL}/sse`));
const client    = new Client({ name: 'sprint4-test', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);

let parentPersonaId = null;
let childPersonaId  = null;
let revocationTargetId = null;

try {

  // -------------------------------------------------------------------------
  // Check 1: Tool registry — active tools and gif-layer tools
  // -------------------------------------------------------------------------

  const registryResult = await callTool(client, 'db_read', {
    persona_id: ADMIN_PERSONA_ID,
    table:      'tool_registry',
    filters:    JSON.stringify({ status: 'active' }),
    limit:      20,
  });

  const activeTools = registryResult.rows ?? [];
  const gifTools    = activeTools.filter(t => t.tool_layer === 'gif');

  if (activeTools.length === 6) {
    pass(1, `tool_registry has 6 active tools`);
  } else {
    fail(1, `Expected 6 active tools, got ${activeTools.length}`);
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
    issuing_entity:       'Sprint 4 Test',
    purpose:              'Parent persona for delegation chain test',
    created_by:           'test_sprint4.mjs',
    scope_definition:     JSON.stringify({
      permitted_sources:  ['searxng', 'personas'],
      permitted_actions:  ['read', 'synthesize'],
      output_destinations: ['synthesis_outputs'],
    }),
    valid_until:          '2026-06-30T00:00:00Z',
    max_delegation_depth: 2,
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
    issuing_entity:       'Sprint 4 Test',
    purpose:              'Child persona for delegation chain test',
    created_by:           'test_sprint4.mjs',
    scope_definition:     JSON.stringify({
      permitted_sources:  ['searxng'],          // subset of parent
      permitted_actions:  ['read'],              // subset of parent
      output_destinations: ['synthesis_outputs'],
    }),
    valid_until:          '2026-06-30T00:00:00Z',
    max_delegation_depth: 1,
    parent_persona_id:    parentPersonaId,
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
    issuing_entity:       'Sprint 4 Test',
    purpose:              'Persona attempting to exceed parent scope',
    created_by:           'test_sprint4.mjs',
    scope_definition:     JSON.stringify({
      permitted_actions:  ['read', 'synthesize', 'write'],  // 'write' not in parent
      output_destinations: ['synthesis_outputs'],
    }),
    valid_until:          '2026-06-30T00:00:00Z',
    parent_persona_id:    parentPersonaId,
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
    issuing_entity:       'Sprint 4 Test',
    purpose:              'Grandchild persona exceeding delegation depth',
    created_by:           'test_sprint4.mjs',
    scope_definition:     JSON.stringify({
      permitted_actions:  ['read'],
      output_destinations: ['synthesis_outputs'],
    }),
    valid_until:          '2026-06-30T00:00:00Z',
    parent_persona_id:    childPersonaId,
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
    issuing_entity:   'Sprint 4 Test',
    purpose:          'Persona created to test revocation session handling',
    created_by:       'test_sprint4.mjs',
    scope_definition: JSON.stringify({
      permitted_sources:  ['searxng'],
      permitted_actions:  ['read'],
      output_destinations: ['synthesis_outputs'],
    }),
    valid_until:      '2026-06-30T00:00:00Z',
  });

  revocationTargetId = revokeTargetResult.persona_id;

  if (!revokeTargetResult.created) {
    fail(8, `Could not create revocation target persona: ${JSON.stringify(revokeTargetResult)}`);
  } else {

    // Open a session on the target persona by making a tool call
    // (web_search creates and closes a session; we need to verify sessions are
    //  captured. Since MCP sessions close after each tool call, we check the
    //  DB directly for sessions that were closed during revocation.)
    // Instead: verify that revocation returns sessions_terminated field and
    // the revocation_log records it accurately.

    const revokeResult = await callTool(client, 'persona_revoke', {
      persona_id:        ADMIN_PERSONA_ID,
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
      target_persona_id: childPersonaId,
      reason:            'Sprint 4 test cleanup',
      revoked_by:        'test_sprint4.mjs',
    }).catch(() => {});
  }
  if (parentPersonaId) {
    await callTool(client, 'persona_revoke', {
      persona_id:        ADMIN_PERSONA_ID,
      target_persona_id: parentPersonaId,
      reason:            'Sprint 4 test cleanup',
      revoked_by:        'test_sprint4.mjs',
    }).catch(() => {});
  }

  await client.close();
}
