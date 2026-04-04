// test_sprint5_read_log.mjs
// =============================================================================
// Sprint 5 validation: audit read log (migration 008).
//
// Validates:
//   1. db_read on audit_events creates an audit_read_log row (verified as postgres)
//   2. audit_read_log row has correct reader_persona_id and rows_returned
//   3. gif_app cannot SELECT from audit_read_log (no SELECT grant)
//   4. db_read on a non-audit table (personas) does NOT create a read_log row
// =============================================================================

import pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const { Pool } = pg;

let passed = 0;
let failed = 0;

function pass(label) { console.log(`  ✓ ${label}`); passed++; }
function fail(label, detail) {
  console.error(`  ✗ ${label}`);
  if (detail) console.error(`    ${detail}`);
  failed++;
}

// ---------------------------------------------------------------------------
// MCP tool call helper — uses MCP SDK (matches existing test pattern)
// ---------------------------------------------------------------------------

const MCP_URL = process.env.MCP_BASE_URL || 'http://localhost:3100';

async function callTool(toolName, args) {
  const transport = new StreamableHTTPClientTransport(new URL(`${MCP_URL}/mcp`));
  const client = new Client({ name: 'test-sprint5-readlog', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  try {
    return await client.callTool({ name: toolName, arguments: args });
  } finally {
    await client.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Two pools: gif_app (application user) and scott/superuser (for verification)
const gifPool = new Pool({
  host:     process.env.PGHOST     || 'localhost',
  port:     parseInt(process.env.PGPORT || '5432'),
  user:     process.env.PGUSER     || 'gif_app',
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'gif',
});
const pgPool = new Pool({
  host:     process.env.PGHOST          || 'localhost',
  port:     parseInt(process.env.PGPORT || '5432'),
  user:     process.env.PGADMINUSER     || 'gif_admin',
  password: process.env.PGADMINPASSWORD,
  database: process.env.PGDATABASE      || 'gif',
});

console.log('\nSprint 5 — Audit Read Log Tests\n');

try {
  // Find a persona that can read audit_events
  const personaResult = await gifPool.query(
    `SELECT persona_id, purpose FROM gif.personas
     WHERE status = 'active'
       AND scope_definition::jsonb -> 'permitted_actions' ? 'read'
       AND scope_definition::jsonb -> 'permitted_sources' ? 'audit_events'
     LIMIT 1`
  );

  if (personaResult.rows.length === 0) {
    console.log('  ⚠ No persona with read + audit_events scope — skipping MCP-based read log tests');
    console.log('  (Create a persona with permitted_actions:read and permitted_sources:audit_events to enable)\n');
  } else {
    const { persona_id: readerId } = personaResult.rows[0];

    // Record timestamp before the db_read call
    const beforeRead = new Date().toISOString();

    // Test 1: db_read on audit_events creates a read_log row
    await callTool('db_read', {
      persona_id: readerId,
      table:      'audit_events',
      limit:      5,
    });

    // Small delay to let fire-and-forget INSERT land
    await new Promise(r => setTimeout(r, 200));

    // Verify as postgres (gif_app has no SELECT on audit_read_log)
    const logCheck = await pgPool.query(
      `SELECT read_id, reader_persona_id, queried_table, rows_returned
       FROM gif.audit_read_log
       WHERE reader_persona_id = $1
         AND read_at >= $2::timestamptz
       ORDER BY read_at DESC
       LIMIT 1`,
      [readerId, beforeRead]
    );

    if (logCheck.rows.length > 0) {
      pass('db_read on audit_events creates an audit_read_log row');
      const logRow = logCheck.rows[0];

      if (logRow.reader_persona_id === readerId) {
        pass('audit_read_log.reader_persona_id matches the calling persona');
      } else {
        fail('audit_read_log.reader_persona_id matches the calling persona',
          `Expected ${readerId}, got ${logRow.reader_persona_id}`);
      }

      if (logRow.queried_table === 'audit_events') {
        pass('audit_read_log.queried_table = "audit_events"');
      } else {
        fail('audit_read_log.queried_table = "audit_events"', `Got: ${logRow.queried_table}`);
      }

      if (typeof logRow.rows_returned === 'number') {
        pass(`audit_read_log.rows_returned is numeric (got ${logRow.rows_returned})`);
      } else {
        fail('audit_read_log.rows_returned is numeric', `Got: ${logRow.rows_returned}`);
      }
    } else {
      fail('db_read on audit_events creates an audit_read_log row', 'No row found in audit_read_log');
    }

    // Test 2: db_read on non-audit table (personas) does NOT create a read_log row
    const beforeRead2 = new Date().toISOString();

    // Find a persona that can read 'personas' table
    const personaReader = await gifPool.query(
      `SELECT persona_id FROM gif.personas
       WHERE status = 'active'
         AND scope_definition::jsonb -> 'permitted_actions' ? 'read'
         AND scope_definition::jsonb -> 'permitted_sources' ? 'personas'
       LIMIT 1`
    );

    if (personaReader.rows.length > 0) {
      await callTool('db_read', {
        persona_id: personaReader.rows[0].persona_id,
        table:      'personas',
        limit:      3,
      });

      await new Promise(r => setTimeout(r, 200));

      const noLogCheck = await pgPool.query(
        `SELECT count(*) AS cnt FROM gif.audit_read_log
         WHERE reader_persona_id = $1
           AND queried_table = 'personas'
           AND read_at >= $2::timestamptz`,
        [personaReader.rows[0].persona_id, beforeRead2]
      );

      if (parseInt(noLogCheck.rows[0].cnt) === 0) {
        pass('db_read on non-audit table (personas) does NOT create an audit_read_log row');
      } else {
        fail('db_read on non-audit table (personas) does NOT create an audit_read_log row',
          `Found ${noLogCheck.rows[0].cnt} unexpected row(s)`);
      }
    } else {
      console.log('  ⚠ No persona with read+personas scope — skipping non-audit table test');
    }
  }

  // Test 3: gif_app cannot SELECT from audit_read_log
  try {
    await gifPool.query(`SELECT count(*) FROM gif.audit_read_log`);
    fail('gif_app cannot SELECT from audit_read_log', 'SELECT succeeded — should be denied');
  } catch (e) {
    if (e.message.includes('permission') || e.message.includes('denied') || e.message.includes('policy')) {
      pass('gif_app cannot SELECT from audit_read_log (permission denied)');
    } else {
      fail('gif_app cannot SELECT from audit_read_log', `Unexpected error: ${e.message}`);
    }
  }

} catch (err) {
  console.error('Test error:', err.message);
  failed++;
} finally {
  await gifPool.end();
  await pgPool.end();
}

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
