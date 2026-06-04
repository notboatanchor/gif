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

// test_mcp.mjs
// =============================================================================
// MCP server end-to-end test — connects via Streamable HTTP, exercises db_read.
//
// Discovers the test persona dynamically (same pattern as test_sprint4.mjs).
// Requires: MCP server running on port 3100, test_setup.mjs run first.
// =============================================================================

import pg from 'pg';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

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

const MCP_URL = process.env.MCP_BASE_URL || 'http://localhost:3100';
const transport = new StreamableHTTPClientTransport(new URL(`${MCP_URL}/mcp`));
const client = new Client({ name: 'test-client', version: '0.1.0' }, { capabilities: {} });

await client.connect(transport);
console.log('[test_mcp] Connected');

// PR2: mint a v0.2 governance session handle (GIF-019/020) and thread it
// through every governed-tool call as gif_session_id.
const startResult = await client.callTool({
  name: 'session_start',
  arguments: { persona_id: PERSONA_ID },
});
const gif_session_id = JSON.parse(startResult.content[0].text).gif_session_id;
console.log(`[test_mcp] gif_session_id: ${gif_session_id}`);

// db_read — round-trip through dispatcher: persona check, session check, audit
console.log('[test_mcp] Calling db_read...');
const dbResult = await client.callTool({
  name: 'db_read',
  arguments: {
    persona_id:     PERSONA_ID,
    gif_session_id,
    table:          'tool_registry',
    limit:          3,
  },
});
console.log('[test_mcp] db_read result:', JSON.stringify(dbResult, null, 2));

// Explicit caller-close per GIF-020.
await client.callTool({
  name: 'session_close',
  arguments: { persona_id: PERSONA_ID, gif_session_id },
});

await client.close();
console.log('[test_mcp] Done');
