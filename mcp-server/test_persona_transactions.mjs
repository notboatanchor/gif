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

// test_persona_transactions.mjs
// =============================================================================
// Transaction-integrity burst: persona_create / persona_revoke under
// concurrency must never strand an open transaction on a pooled connection.
//
// The defect this guards against: transaction statements issued through bare
// pool.query() (BEGIN on one checkout, INSERT on another, COMMIT on a third)
// stop being a transaction under concurrent load, and the connection that ran
// BEGIN returns to the pool inside an open transaction. Any later query that
// checks out that connection joins the stale transaction; if that query is an
// audit INSERT it acquires the migration-016 chain-serialization lock and
// never releases it — blocking every audit write on the database. The fix
// runs each transaction on a dedicated pool.connect() client released in
// finally, with idle_in_transaction_session_timeout as defense in depth.
//
// Validates (against the running MCP server — MCP_BASE_URL):
//   1. BURST concurrent persona_creates (interleaved with persona_validate
//      noise to force pool-checkout contention) all succeed and all rows
//      exist — at the shipped BURST the pre-fix code loses rows (see the
//      calibration note at the BURST constant below).
//   2. After the burst settles, NO gif_app connection is left 'idle in
//      transaction' across a 2.5s sweep — the stranding signature.
//   3. BURST concurrent persona_revokes all succeed; revocation_log rows
//      present; personas revoked.
//   4. Same idle-in-transaction sweep after the revoke burst.
//
// Visibility note: pg_stat_activity masks state for other roles' backends —
// this test connects as gif_app, the same role as the server pool, so the
// sweep sees the server's connections.
//
// Requires: IDENTITY_HMAC_SECRET (skips cleanly if unset, matching
// test_identity_binding.mjs), an active persona with manage_personas, and
// migrations through 016.
// =============================================================================

import pg from 'pg';
import crypto from 'crypto';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const { Pool } = pg;

const pool = new Pool({
  host:     process.env.PGHOST     || 'localhost',
  port:     parseInt(process.env.PGPORT || '5432'),
  user:     process.env.PGUSER     || 'gif_app',
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'gif',
});

const hmacSecret = process.env.IDENTITY_HMAC_SECRET;
const MCP_URL = process.env.MCP_BASE_URL || 'http://localhost:3100';

// Burst size calibration (review-verified, 2026-08-05): at 8 the pre-fix
// pool.query('BEGIN') defect SELF-MASKS — stray COMMITs from interleaved
// calls close stolen transactions, so 8 passes even on broken code. At 40,
// the pre-fix build loses data in most runs (created:true returned for rows
// that were silently rolled back) while the fixed build stays clean. 40 is
// the shipped default so this guard has real trip power against a revert.
const BURST = parseInt(process.env.TEST_TXN_BURST || '40');

let passed = 0;
let failed = 0;

function pass(label) { console.log(`  ✓ ${label}`); passed++; }
function fail(label, detail) {
  console.error(`  ✗ ${label}`);
  if (detail) console.error(`    ${detail}`);
  failed++;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Token helper (mirrors src/cli/issue_identity_token.ts)
function issueToken(assignmentId, secret) {
  const payload = Buffer.from(JSON.stringify({
    assignment_id: assignmentId,
    issued_at:     new Date().toISOString(),
  })).toString('base64url');
  const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${hmac}`;
}

async function callTool(toolName, args) {
  const transport = new StreamableHTTPClientTransport(new URL(`${MCP_URL}/mcp`));
  const client = new Client({ name: 'test-persona-transactions', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  try {
    return await client.callTool({ name: toolName, arguments: args });
  } finally {
    await client.close().catch(() => {});
  }
}

// Post-burst stranding sweep: sample pg_stat_activity for 2.5s; any gif_app
// backend sitting 'idle in transaction' after all responses have returned is
// a stranded transaction (legitimate in-transaction idle time is
// milliseconds DURING a call, never after the response).
async function assertNoStrandedTransactions(label) {
  const samples = 10;
  let worst = 0;
  for (let i = 0; i < samples; i++) {
    const res = await pool.query(
      `SELECT count(*)::int AS n
         FROM pg_stat_activity
        WHERE usename = 'gif_app'
          AND state = 'idle in transaction'
          AND pid <> pg_backend_pid()`
    );
    worst = Math.max(worst, res.rows[0].n);
    await sleep(250);
  }
  if (worst === 0) {
    pass(`${label}: no gif_app connection stranded 'idle in transaction' (10 samples / 2.5s)`);
  } else {
    fail(`${label}: no gif_app connection stranded 'idle in transaction'`,
      `observed ${worst} idle-in-transaction connection(s) after the burst settled — stranded BEGIN`);
  }
}

console.log('\n=== Persona transaction integrity under concurrency ===\n');

if (!hmacSecret) {
  console.error('IDENTITY_HMAC_SECRET not set — skipping persona transaction tests');
  await pool.end();
  process.exit(0);
}

try {
  // Issuer: active persona with manage_personas (seeded by earlier suite tests).
  const issuerResult = await pool.query(
    `SELECT persona_id FROM gif.personas
      WHERE status = 'active'
        AND scope_definition::jsonb -> 'permitted_actions' ? 'manage_personas'
      LIMIT 1`
  );
  if (issuerResult.rows.length === 0) {
    throw new Error('No active persona with manage_personas found — run earlier suite tests first');
  }
  const issuerId = issuerResult.rows[0].persona_id;

  const sessionResult = await callTool('session_start', { persona_id: issuerId });
  const gif_session_id = JSON.parse(sessionResult.content[0].text).gif_session_id;

  // One identity assignment + token per create (assignments are per-persona
  // provisioning records; do not reuse one across creates).
  const TEST_TAG = `txn_burst_${Date.now()}`;
  const tokens = [];
  for (let i = 0; i < BURST; i++) {
    const a = await pool.query(
      `INSERT INTO gif.user_persona_assignments
         (external_user_id, persona_id, assigned_by, purpose_for_assignment,
          verified_identity_ref, identity_provider_hint)
       VALUES ($1, $2, 'test_runner', 'transaction burst test',
               'test-identity', 'local-test')
       RETURNING assignment_id`,
      [`${TEST_TAG}_${i}`, issuerId]
    );
    tokens.push(issueToken(a.rows[0].assignment_id, hmacSecret));
  }

  const scope = JSON.stringify({
    permitted_sources:   ['test_source'],
    permitted_actions:   ['read'],
    output_destinations: ['test_output'],
  });

  // ---------------------------------------------------------------------------
  // 1. Concurrent create burst + validate noise
  // ---------------------------------------------------------------------------
  console.log(`1. ${BURST} concurrent persona_creates (+${BURST} persona_validate noise calls)`);

  const createCalls = tokens.map((token, i) => callTool('persona_create', {
    persona_id:       issuerId,
    gif_session_id,
    issuing_entity:   'test_runner',
    purpose:          `transaction burst test persona ${i} (${TEST_TAG})`,
    created_by:       'test_persona_transactions',
    scope_definition: scope,
    valid_until:      '2027-01-01T00:00:00Z',
    identity_token:   token,
  }));
  const noiseCalls = Array.from({ length: BURST }, () =>
    callTool('persona_validate', { persona_id: issuerId }));

  const createResults = await Promise.all(createCalls);
  await Promise.all(noiseCalls);

  const createdIds = [];
  for (const r of createResults) {
    try {
      const parsed = JSON.parse(r.content[0].text);
      if (parsed.created && parsed.persona_id) createdIds.push(parsed.persona_id);
    } catch { /* counted as failure below */ }
  }
  if (createdIds.length === BURST) {
    pass(`all ${BURST} concurrent creates succeeded`);
  } else {
    fail(`all ${BURST} concurrent creates succeeded`,
      `${createdIds.length}/${BURST} returned created:true`);
  }

  const rowCheck = await pool.query(
    `SELECT count(*)::int AS n FROM gif.personas WHERE persona_id = ANY($1::uuid[])`,
    [createdIds]
  );
  if (rowCheck.rows[0].n === createdIds.length && createdIds.length === BURST) {
    pass('every created persona row exists (atomic commits)');
  } else {
    fail('every created persona row exists (atomic commits)',
      `${rowCheck.rows[0].n} rows for ${createdIds.length} reported creates`);
  }

  // ---------------------------------------------------------------------------
  // 2. Stranding sweep after create burst
  // ---------------------------------------------------------------------------
  console.log('2. Stranding sweep after create burst');
  await assertNoStrandedTransactions('post-create');

  // ---------------------------------------------------------------------------
  // 3. Concurrent revoke burst
  // ---------------------------------------------------------------------------
  console.log(`3. ${BURST} concurrent persona_revokes`);

  const revokeResults = await Promise.all(createdIds.map((target, i) =>
    callTool('persona_revoke', {
      persona_id:        issuerId,
      gif_session_id,
      target_persona_id: target,
      reason:            `transaction burst cleanup ${i} (${TEST_TAG})`,
      revoked_by:        'test_persona_transactions',
    })));

  let revokedCount = 0;
  for (const r of revokeResults) {
    try {
      const parsed = JSON.parse(r.content[0].text);
      if (parsed.revoked) revokedCount++;
    } catch { /* counted as failure below */ }
  }
  if (revokedCount === createdIds.length && createdIds.length === BURST) {
    pass(`all ${BURST} concurrent revokes succeeded`);
  } else {
    fail(`all ${BURST} concurrent revokes succeeded`, `${revokedCount}/${createdIds.length}`);
  }

  const revokeCheck = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM gif.personas
         WHERE persona_id = ANY($1::uuid[]) AND status = 'revoked') AS revoked_personas,
       (SELECT count(*)::int FROM gif.revocation_log
         WHERE persona_id = ANY($1::uuid[])) AS log_rows`,
    [createdIds]
  );
  const { revoked_personas, log_rows } = revokeCheck.rows[0];
  if (revoked_personas === BURST && log_rows === BURST) {
    pass('revocations atomic: every persona revoked AND logged');
  } else {
    fail('revocations atomic: every persona revoked AND logged',
      `revoked=${revoked_personas}, revocation_log rows=${log_rows}, expected ${BURST} of each`);
  }

  // ---------------------------------------------------------------------------
  // 4. Stranding sweep after revoke burst
  // ---------------------------------------------------------------------------
  console.log('4. Stranding sweep after revoke burst');
  await assertNoStrandedTransactions('post-revoke');

  await callTool('session_close', { persona_id: issuerId, gif_session_id });
} catch (err) {
  fail('unexpected test error', err.stack || String(err));
} finally {
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
