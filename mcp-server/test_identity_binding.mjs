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

// test_sprint5_identity_binding.mjs
// =============================================================================
// Sprint 5 validation: user-to-persona identity binding (migration 007).
//
// Validates:
//   1. persona_create with a valid token succeeds and consumes the token
//   2. Re-use of a consumed token is rejected
//   3. A tampered token (bad HMAC) is rejected
//   4. persona_create without identity_token is rejected (required field)
//   5. Consumed assignment has token_consumed_at set
//   6. Successful persona_create audit event has human_actor_id populated
// =============================================================================

import pg from 'pg';
import crypto from 'crypto';
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
// Token helpers (mirrors src/cli/issue_identity_token.ts)
// ---------------------------------------------------------------------------

function issueToken(assignmentId, secret, issuedAt) {
  const payload = Buffer.from(JSON.stringify({
    assignment_id: assignmentId,
    issued_at:     issuedAt ?? new Date().toISOString(),
  })).toString('base64url');
  const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${hmac}`;
}

// ---------------------------------------------------------------------------
// MCP tool call helper — uses MCP SDK (matches existing test pattern)
// ---------------------------------------------------------------------------

const MCP_URL = process.env.MCP_BASE_URL || 'http://localhost:3100';

async function callTool(toolName, args) {
  const transport = new StreamableHTTPClientTransport(new URL(`${MCP_URL}/mcp`));
  const client = new Client({ name: 'test-sprint5-identity', version: '0.1.0' }, { capabilities: {} });
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

const pool = new Pool({
  host:     process.env.PGHOST     || 'localhost',
  port:     parseInt(process.env.PGPORT || '5432'),
  user:     process.env.PGUSER     || 'gif_app',
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'gif',
});
const hmacSecret = process.env.IDENTITY_HMAC_SECRET;

console.log('\nSprint 5 — Identity Binding Tests\n');

if (!hmacSecret) {
  console.error('IDENTITY_HMAC_SECRET not set — skipping identity binding tests');
  console.log('Set IDENTITY_HMAC_SECRET in .env to enable these tests\n');
  await pool.end();
  process.exit(0);
}

try {
  // Find an issuer persona with manage_personas
  const issuerResult = await pool.query(
    `SELECT persona_id FROM gif.personas
     WHERE status = 'active'
       AND scope_definition::jsonb -> 'permitted_actions' ? 'manage_personas'
     LIMIT 1`
  );
  if (issuerResult.rows.length === 0) {
    throw new Error('No active persona with manage_personas found');
  }
  const issuerId = issuerResult.rows[0].persona_id;

  // Create an assignment for testing
  const assignmentResult = await pool.query(
    `INSERT INTO gif.user_persona_assignments
       (external_user_id, persona_id, assigned_by, purpose_for_assignment,
        verified_identity_ref, identity_provider_hint)
     VALUES ('test-user-sprint5', $1, 'test_runner', 'Sprint 5 identity binding test',
             'test-identity', 'local-test')
     RETURNING assignment_id`,
    [issuerId]
  );
  const assignmentId = assignmentResult.rows[0].assignment_id;

  // Test 1: persona_create with valid token succeeds
  const token = issueToken(assignmentId, hmacSecret);
  const scope = JSON.stringify({
    permitted_sources:  ['test_source'],
    permitted_actions:  ['read'],
    output_destinations: ['test_output'],
  });

  const result1 = await callTool('persona_create', {
    persona_id:      issuerId,
    issuing_entity:  'test_runner',
    purpose:         'Sprint 5 identity binding test persona',
    created_by:      'test_sprint5',
    scope_definition: scope,
    valid_until:     '2027-01-01T00:00:00Z',
    identity_token:  token,
  });

  const content1 = result1?.content?.[0]?.text;
  let createdPersonaId;
  let identityAssignmentId;
  if (content1) {
    try {
      const parsed = JSON.parse(content1);
      createdPersonaId     = parsed.persona_id;
      identityAssignmentId = parsed.identity_assignment_id;
      if (parsed.created && createdPersonaId) {
        pass('persona_create with valid identity_token succeeds');
      } else {
        fail('persona_create with valid identity_token succeeds', content1);
      }
    } catch {
      fail('persona_create with valid identity_token succeeds', content1);
    }
  } else {
    fail('persona_create with valid identity_token succeeds', JSON.stringify(result1));
  }

  // Test 2: identity_assignment_id is returned in result
  if (identityAssignmentId === assignmentId) {
    pass('persona_create result includes identity_assignment_id matching the consumed assignment');
  } else {
    fail('persona_create result includes identity_assignment_id',
      `Expected ${assignmentId}, got ${identityAssignmentId}`);
  }

  // Test 3: token is now consumed in DB
  const consumedCheck = await pool.query(
    `SELECT token_consumed, token_consumed_at
     FROM gif.user_persona_assignments
     WHERE assignment_id = $1`,
    [assignmentId]
  );
  const row = consumedCheck.rows[0];
  if (row?.token_consumed === true && row?.token_consumed_at !== null) {
    pass('Assignment token_consumed = true with token_consumed_at set after use');
  } else {
    fail('Assignment token_consumed = true with token_consumed_at set after use',
      JSON.stringify(row));
  }

  // Test 4: re-use of consumed token is rejected
  const result2 = await callTool('persona_create', {
    persona_id:       issuerId,
    issuing_entity:   'test_runner',
    purpose:          'Should fail — consumed token',
    created_by:       'test_sprint5',
    scope_definition: scope,
    valid_until:      '2027-01-01T00:00:00Z',
    identity_token:   token,
  });
  const content2 = result2?.content?.[0]?.text ?? '';
  if (content2.includes('consumed') || content2.includes('not found') || content2.includes('binding')) {
    pass('Re-use of consumed token is rejected');
  } else if (result2?.isError) {
    pass('Re-use of consumed token is rejected (isError=true)');
  } else {
    fail('Re-use of consumed token is rejected', content2);
  }

  // Test 5: tampered token (bad HMAC) is rejected
  const tamperedToken = token.slice(0, -4) + 'ffff';
  const result3 = await callTool('persona_create', {
    persona_id:       issuerId,
    issuing_entity:   'test_runner',
    purpose:          'Should fail — bad HMAC',
    created_by:       'test_sprint5',
    scope_definition: scope,
    valid_until:      '2027-01-01T00:00:00Z',
    identity_token:   tamperedToken,
  });
  const content3 = result3?.content?.[0]?.text ?? '';
  if (content3.includes('signature') || content3.includes('binding') || result3?.isError) {
    pass('Tampered token (bad HMAC) is rejected');
  } else {
    fail('Tampered token (bad HMAC) is rejected', content3);
  }

  // Test 6: persona_create without identity_token is rejected (required field)
  const result4 = await callTool('persona_create', {
    persona_id:       issuerId,
    issuing_entity:   'test_runner',
    purpose:          'Should fail — no identity_token',
    created_by:       'test_sprint5',
    scope_definition: scope,
    valid_until:      '2027-01-01T00:00:00Z',
    // no identity_token
  });
  const content4 = result4?.content?.[0]?.text ?? '';
  if (result4?.isError || content4.includes('binding') || content4.includes('token') || content4.includes('required')) {
    pass('persona_create without identity_token is rejected');
  } else {
    fail('persona_create without identity_token is rejected',
      `Expected rejection, got: ${content4}`);
  }

  // Test 7: human_actor_id is set on the audit event for the token-bound creation
  if (createdPersonaId) {
    const auditCheck = await pool.query(
      `SELECT human_actor_id FROM gif.audit_events
       WHERE event_type = 'persona_create'
         AND source_ref = $1
       LIMIT 1`,
      [createdPersonaId]
    );
    if (auditCheck.rows[0]?.human_actor_id === assignmentId) {
      pass('Audit event has human_actor_id = assignment UUID for token-bound persona_create');
    } else {
      fail('Audit event has human_actor_id = assignment UUID',
        `Expected ${assignmentId}, got ${auditCheck.rows[0]?.human_actor_id}`);
    }
  }

} catch (err) {
  console.error('Test error:', err.message);
  failed++;
} finally {
  await pool.end();
}

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
