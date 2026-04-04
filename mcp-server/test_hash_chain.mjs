// test_sprint5_hash_chain.mjs
// =============================================================================
// Sprint 5 validation: audit event hash chain (migration 006).
//
// Validates:
//   1. New audit events have non-null event_hash (64 hex chars)
//   2. Second event's previous_hash equals first event's event_hash
//   3. Computed hash matches expected SHA-256 of the preimage
//   4. gif_app cannot UPDATE event_hash (append-only RLS)
//   5. audit_chain_anchors INSERT and SELECT work for gif_app
// =============================================================================

import pg from 'pg';
import crypto from 'crypto';

const { Pool } = pg;

// Connection config matches test_sprint3.mjs pattern (PGHOST/PGUSER/PGPASSWORD)
const dbConfig = {
  host:     process.env.PGHOST     || 'localhost',
  port:     parseInt(process.env.PGPORT || '5432'),
  user:     process.env.PGUSER     || 'gif_app',
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'gif',
};

let passed = 0;
let failed = 0;

function pass(label) {
  console.log(`  ✓ ${label}`);
  passed++;
}

function fail(label, detail) {
  console.error(`  ✗ ${label}`);
  if (detail) console.error(`    ${detail}`);
  failed++;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeExpectedHash(row, prevHash) {
  const preimage = [
    row.event_id,
    row.occurred_at.toISOString(),
    row.persona_id,
    row.session_id ?? 'NULL',
    row.event_type,
    row.tool_name ?? 'NULL',
    row.outcome,
    String(row.flagged),
    prevHash ?? 'NULL',
  ].join('|');
  return crypto.createHash('sha256').update(preimage, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const pool = new Pool(dbConfig);

console.log('\nSprint 5 — Hash Chain Tests\n');

try {
  // Fetch a persona to use for test events
  const personaResult = await pool.query(
    `SELECT persona_id FROM gif.personas WHERE status = 'active' LIMIT 1`
  );
  if (personaResult.rows.length === 0) {
    throw new Error('No active persona found — run earlier sprint tests first');
  }
  const personaId = personaResult.rows[0].persona_id;

  // Create a session for the test events
  const sessionResult = await pool.query(
    `INSERT INTO gif.sessions (persona_id, invocation_context)
     VALUES ($1, $2) RETURNING session_id`,
    [personaId, JSON.stringify({ test: 'sprint5_hash_chain' })]
  );
  const sessionId = sessionResult.rows[0].session_id;

  // Insert first test audit event
  await pool.query(
    `INSERT INTO gif.audit_events
       (persona_id, session_id, event_type, tool_name, outcome, flagged, purpose_declared)
     VALUES ($1, $2, 'tool_call', 'test_hash_1', 'success', false, 'hash chain test')`,
    [personaId, sessionId]
  );

  // Insert second test audit event
  await pool.query(
    `INSERT INTO gif.audit_events
       (persona_id, session_id, event_type, tool_name, outcome, flagged, purpose_declared)
     VALUES ($1, $2, 'tool_call', 'test_hash_2', 'success', false, 'hash chain test')`,
    [personaId, sessionId]
  );

  // Fetch the two events we just inserted
  const events = await pool.query(
    `SELECT event_id, event_hash, previous_hash, occurred_at,
            persona_id, session_id, event_type, tool_name, outcome, flagged
     FROM gif.audit_events
     WHERE session_id = $1
     ORDER BY occurred_at ASC, event_id ASC`,
    [sessionId]
  );

  if (events.rows.length < 2) {
    throw new Error(`Expected 2 events, got ${events.rows.length}`);
  }

  const [ev1, ev2] = events.rows;

  // Test 1: event_hash is non-null and 64 hex chars
  if (ev1.event_hash && /^[0-9a-f]{64}$/.test(ev1.event_hash)) {
    pass('First event has valid 64-char hex event_hash');
  } else {
    fail('First event has valid 64-char hex event_hash', `Got: ${ev1.event_hash}`);
  }

  if (ev2.event_hash && /^[0-9a-f]{64}$/.test(ev2.event_hash)) {
    pass('Second event has valid 64-char hex event_hash');
  } else {
    fail('Second event has valid 64-char hex event_hash', `Got: ${ev2.event_hash}`);
  }

  // Test 2: chain linkage — second event's previous_hash == first event's event_hash
  if (ev2.previous_hash === ev1.event_hash) {
    pass('Hash chain linked: ev2.previous_hash === ev1.event_hash');
  } else {
    fail('Hash chain linked: ev2.previous_hash === ev1.event_hash',
      `ev2.previous_hash=${ev2.previous_hash}, ev1.event_hash=${ev1.event_hash}`);
  }

  // Test 3: verify hash computation matches expected SHA-256
  // Note: occurred_at format in the preimage uses Postgres timestamptz text representation.
  // We compare the DB-computed hash against a JS recomputation using the same
  // occurred_at string as stored. Fetch the raw text to match the preimage exactly.
  const rawRows = await pool.query(
    `SELECT event_id::text,
            occurred_at::text,
            persona_id::text,
            session_id::text,
            event_type,
            tool_name,
            outcome,
            flagged::text,
            event_hash,
            previous_hash
     FROM gif.audit_events
     WHERE session_id = $1
     ORDER BY occurred_at ASC, event_id ASC`,
    [sessionId]
  );

  const raw1 = rawRows.rows[0];
  const preimage1 = [
    raw1.event_id,
    raw1.occurred_at,
    raw1.persona_id,
    raw1.session_id ?? 'NULL',
    raw1.event_type,
    raw1.tool_name ?? 'NULL',
    raw1.outcome,
    raw1.flagged,
    raw1.previous_hash ?? 'NULL',
  ].join('|');

  const expectedHash1 = crypto.createHash('sha256').update(preimage1, 'utf8').digest('hex');

  if (expectedHash1 === raw1.event_hash) {
    pass('event_hash matches expected SHA-256(preimage)');
  } else {
    fail('event_hash matches expected SHA-256(preimage)',
      `Expected: ${expectedHash1}\nGot:      ${raw1.event_hash}\nPreimage: ${preimage1}`);
  }

  // Test 4: gif_app cannot UPDATE event_hash (RLS append-only enforcement)
  try {
    await pool.query(
      `UPDATE gif.audit_events SET event_hash = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
       WHERE event_id = $1`,
      [ev1.event_id]
    );
    fail('gif_app UPDATE of event_hash is blocked by RLS', 'UPDATE succeeded — should have failed');
  } catch (e) {
    if (e.message.includes('permission') || e.message.includes('policy') || e.message.includes('UPDATE')) {
      pass('gif_app cannot UPDATE event_hash (RLS blocks it)');
    } else {
      fail('gif_app cannot UPDATE event_hash (RLS blocks it)', `Unexpected error: ${e.message}`);
    }
  }

  // Test 5: audit_chain_anchors INSERT and SELECT
  await pool.query(
    `INSERT INTO gif.audit_chain_anchors
       (event_id, anchor_hash, partition_name, event_count, anchored_by, notes)
     VALUES ($1, $2, 'audit_events_2026_03', 2, 'test_sprint5', 'sprint5 hash chain test')`,
    [ev1.event_id, ev1.event_hash]
  );

  const anchors = await pool.query(
    `SELECT anchor_id FROM gif.audit_chain_anchors WHERE anchored_by = 'test_sprint5'`
  );

  if (anchors.rows.length > 0) {
    pass('audit_chain_anchors: INSERT and SELECT work for gif_app');
  } else {
    fail('audit_chain_anchors: INSERT and SELECT work for gif_app', 'No anchor rows found after insert');
  }

  // Cleanup
  await pool.query(`UPDATE gif.sessions SET ended_at = now() WHERE session_id = $1`, [sessionId]);

} catch (err) {
  console.error('Test error:', err.message);
  failed++;
} finally {
  await pool.end();
}

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
