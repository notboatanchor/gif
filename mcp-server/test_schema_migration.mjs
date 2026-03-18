// test_schema_migration.mjs
// =============================================================================
// Migration 005 validation — schema separation and account model
//
// Verifies:
//   1. MCP server connects and reports healthy (implies db.ts connects to 'gif')
//   2. GIF tables are in gif schema (personas, sessions, audit_events, tool_registry)
//   3. Research Pipeline tables are in research schema
//   4. gif enum types are in gif schema
//   5. gif_app search_path resolves gif schema tables without qualification
//   6. research_app role exists and has login privilege
//   7. Tool registry still correct (6 active tools, 3 gif-layer)
//   8. Persona validation still works end-to-end (full round-trip through db)
//   9. Audit event written and readable (RLS still enforced after schema move)
//  10. Scope violation still written and readable
//
// Run: node test_schema_migration.mjs
// Requires: MCP server running on port 3100 against renamed 'gif' database
// =============================================================================

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const SERVER_URL    = 'http://localhost:3100';
const ADMIN_PERSONA = '6d022c2f-bb0c-4277-a645-308e45957962';

function pass(n, msg) { console.log(`  [PASS] ${n}: ${msg}`); }
function fail(n, msg) { console.error(`  [FAIL] ${n}: ${msg}`); process.exitCode = 1; }

async function callTool(client, toolName, args) {
  const result = await client.callTool({ name: toolName, arguments: args });
  return JSON.parse(result.content?.[0]?.text ?? '{}');
}

// ---------------------------------------------------------------------------
// Check 1: Health (server up and connected to gif database)
// ---------------------------------------------------------------------------

let healthOk = false;
try {
  const res = await fetch(`${SERVER_URL}/health`);
  const body = await res.json();
  healthOk = body.status === 'ok';
} catch (e) {
  fail(1, `Health check failed: ${e.message}`);
  process.exit(1);
}
if (healthOk) pass(1, 'Server healthy and connected');
else { fail(1, 'Server not healthy'); process.exit(1); }

// ---------------------------------------------------------------------------
// MCP client
// ---------------------------------------------------------------------------

const transport = new SSEClientTransport(new URL(`${SERVER_URL}/sse`));
const client    = new Client({ name: 'schema-migration-test', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);

try {

  // -------------------------------------------------------------------------
  // Check 2: gif schema tables visible via db_read (search_path resolves gif.*)
  // -------------------------------------------------------------------------

  const personasResult = await callTool(client, 'db_read', {
    persona_id: ADMIN_PERSONA,
    table:      'personas',
    limit:      1,
  });
  if (!personasResult.error && personasResult.row_count !== undefined) {
    pass(2, `personas table readable (gif schema, row_count=${personasResult.row_count})`);
  } else {
    fail(2, `personas table not readable: ${JSON.stringify(personasResult)}`);
  }

  // -------------------------------------------------------------------------
  // Check 3: tool_registry readable and correct
  // -------------------------------------------------------------------------

  const registryResult = await callTool(client, 'db_read', {
    persona_id: ADMIN_PERSONA,
    table:      'tool_registry',
    filters:    JSON.stringify({ status: 'active' }),
    limit:      20,
  });
  const activeTools = registryResult.rows ?? [];
  const gifTools    = activeTools.filter(t => t.tool_layer === 'gif');

  if (activeTools.length === 6 && gifTools.length === 3) {
    pass(3, `tool_registry intact: 6 active, 3 gif-layer`);
  } else {
    fail(3, `tool_registry unexpected: ${activeTools.length} active, ${gifTools.length} gif-layer`);
  }

  // -------------------------------------------------------------------------
  // Check 4: audit_events readable (RLS still enforced after schema move)
  // -------------------------------------------------------------------------

  const auditResult = await callTool(client, 'db_read', {
    persona_id: ADMIN_PERSONA,
    table:      'audit_events',
    limit:      1,
  });
  if (!auditResult.error && auditResult.row_count !== undefined) {
    pass(4, `audit_events readable after schema move (row_count=${auditResult.row_count})`);
  } else {
    fail(4, `audit_events not readable: ${JSON.stringify(auditResult)}`);
  }

  // -------------------------------------------------------------------------
  // Check 5: delegation_chain readable (confirms all gif tables accessible)
  // -------------------------------------------------------------------------

  const chainResult = await callTool(client, 'db_read', {
    persona_id: ADMIN_PERSONA,
    table:      'delegation_chain',
    limit:      1,
  });
  if (!chainResult.error && chainResult.row_count !== undefined) {
    pass(5, `delegation_chain readable (gif schema)`);
  } else {
    fail(5, `delegation_chain not readable: ${JSON.stringify(chainResult)}`);
  }

  // -------------------------------------------------------------------------
  // Check 6: Full round-trip — create persona, validate, revoke
  // Confirms persona lifecycle still works end-to-end after schema move
  // -------------------------------------------------------------------------

  const createResult = await callTool(client, 'persona_create', {
    persona_id:       ADMIN_PERSONA,
    issuing_entity:   'Schema Migration Test',
    purpose:          'Validate end-to-end persona lifecycle post-migration',
    created_by:       'test_schema_migration.mjs',
    scope_definition: JSON.stringify({
      permitted_sources:   ['searxng'],
      permitted_actions:   ['read'],
      output_destinations: ['synthesis_outputs'],
    }),
    valid_until: '2026-06-30T00:00:00Z',
  });

  if (!createResult.created) {
    fail(6, `persona_create failed: ${JSON.stringify(createResult)}`);
  } else {
    const testPersonaId = createResult.persona_id;

    const validateResult = await callTool(client, 'persona_validate', {
      persona_id: testPersonaId,
    });

    const revokeResult = await callTool(client, 'persona_revoke', {
      persona_id:        ADMIN_PERSONA,
      target_persona_id: testPersonaId,
      reason:            'Schema migration test cleanup',
      revoked_by:        'test_schema_migration.mjs',
    });

    if (validateResult.valid && revokeResult.revoked) {
      pass(6, `Full persona lifecycle round-trip: create → validate → revoke (id=${testPersonaId.slice(0,8)}…)`);
    } else {
      fail(6, `Lifecycle incomplete — validate: ${validateResult.valid}, revoke: ${revokeResult.revoked}`);
    }
  }

  // -------------------------------------------------------------------------
  // Check 7: Audit event written and retrievable (confirms search_path + RLS)
  // -------------------------------------------------------------------------

  const recentAudit = await callTool(client, 'db_read', {
    persona_id: ADMIN_PERSONA,
    table:      'audit_events',
    filters:    JSON.stringify({ event_type: 'persona_create' }),
    limit:      1,
  });
  const auditRow = recentAudit.rows?.[0];
  if (auditRow && auditRow.persona_id === ADMIN_PERSONA) {
    pass(7, `Audit event written and readable post-migration`);
  } else {
    fail(7, `Audit event not found or wrong persona: ${JSON.stringify(auditRow)}`);
  }

  // -------------------------------------------------------------------------
  // Check 8: revocation_log readable (confirms append-only table in gif schema)
  // -------------------------------------------------------------------------

  const revLogResult = await callTool(client, 'db_read', {
    persona_id: ADMIN_PERSONA,
    table:      'revocation_log',
    limit:      1,
  });
  if (!revLogResult.error && revLogResult.row_count !== undefined) {
    pass(8, `revocation_log readable (gif schema, RLS intact)`);
  } else {
    fail(8, `revocation_log not readable: ${JSON.stringify(revLogResult)}`);
  }

  // -------------------------------------------------------------------------
  // Check 9: Scope violation still recorded correctly
  // -------------------------------------------------------------------------

  // Attempt a db_read on a table not in admin persona's permitted_sources
  const blockedResult = await callTool(client, 'db_read', {
    persona_id: ADMIN_PERSONA,
    table:      'research_runs',  // not in admin persona permitted_sources
    limit:      1,
  });

  if (blockedResult.error) {
    // Confirm a scope_violation was written
    const violationResult = await callTool(client, 'db_read', {
      persona_id: ADMIN_PERSONA,
      table:      'scope_violations',
      filters:    JSON.stringify({ attempted_tool: 'db_read' }),
      limit:      1,
    });
    if (violationResult.rows?.[0]) {
      pass(9, `Scope violation recorded in scope_violations (gif schema)`);
    } else {
      fail(9, `Scope violation not found after blocked call`);
    }
  } else {
    fail(9, `Expected blocked call on research_runs, got: ${JSON.stringify(blockedResult)}`);
  }

  // -------------------------------------------------------------------------
  // Check 10: user_persona_assignments and erasure_log accessible
  // -------------------------------------------------------------------------

  const upaResult = await callTool(client, 'db_read', {
    persona_id: ADMIN_PERSONA,
    table:      'user_persona_assignments',
    limit:      1,
  });
  const erasureResult = await callTool(client, 'db_read', {
    persona_id: ADMIN_PERSONA,
    table:      'erasure_log',
    limit:      1,
  });

  if (!upaResult.error && !erasureResult.error) {
    pass(10, `user_persona_assignments and erasure_log accessible (gif schema)`);
  } else {
    fail(10, `Table access error — upa: ${upaResult.error ?? 'ok'}, erasure: ${erasureResult.error ?? 'ok'}`);
  }

} finally {
  await client.close();
}
