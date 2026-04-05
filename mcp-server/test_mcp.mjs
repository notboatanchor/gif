// test_mcp.mjs
// =============================================================================
// MCP server end-to-end test — connects via Streamable HTTP, exercises db_read.
//
// Discovers the test persona dynamically (same pattern as test_sprint4.mjs).
// Requires: MCP server running on port 3100, test_setup.mjs run first.
// =============================================================================

import pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const { Pool } = pg;

// Discover persona from DB — must have read scope
const pool = new Pool({
  host:     process.env.PGHOST     || 'localhost',
  port:     parseInt(process.env.PGPORT || '5432'),
  user:     process.env.PGUSER     || 'gif_app',
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'gif',
});

const row = await pool.query(
  `SELECT persona_id FROM gif.personas
   WHERE status = 'active'
     AND scope_definition->'permitted_actions' ? 'read'
   LIMIT 1`
);
await pool.end();

if (row.rows.length === 0) {
  console.error('[test_mcp] No active persona with read scope — run test_setup.mjs first');
  process.exit(1);
}

const PERSONA_ID = row.rows[0].persona_id;
console.log(`[test_mcp] Using persona: ${PERSONA_ID}`);

const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3100/mcp'));
const client = new Client({ name: 'test-client', version: '0.1.0' }, { capabilities: {} });

await client.connect(transport);
console.log('[test_mcp] Connected');

// db_read — round-trip through enforcement engine: validate, session, audit, close
console.log('[test_mcp] Calling db_read...');
const dbResult = await client.callTool({
  name: 'db_read',
  arguments: {
    persona_id: PERSONA_ID,
    table:      'tool_registry',
    limit:      3,
  },
});
console.log('[test_mcp] db_read result:', JSON.stringify(dbResult, null, 2));

await client.close();
console.log('[test_mcp] Done');
