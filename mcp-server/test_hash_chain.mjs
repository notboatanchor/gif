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

// gif-audit/2 canonicalizer (replica of verify_audit_chain.ts; guarded
// against drift from the reference vectors by the KAT in test_chain_verifier.mjs).
const MAX_FIELD_LEN = 8192;

function normalizeString(str) {
  if (/[\u0000-\u001f\u007f]/.test(str)) {
    throw new Error('control character in protected string field');
  }
  const n = str.normalize('NFC').trim();
  if (n.length > MAX_FIELD_LEN) {
    throw new Error('protected string field exceeds length cap');
  }
  return n;
}

function canonicalize(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(normalizeString(value));
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (typeof value === 'object') {
    const obj = value;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
  }
  throw new Error(`uncanonicalizable value of type ${typeof value}`);
}

// Build the gif-audit/2 canonical body from a row whose fields are shaped as fetched
// (occurred_at = ms-RFC3339 string, flagged = boolean), then SHA-256 it. Mirrors
// buildBodyV2() in verify_audit_chain.ts and the migration-015 trigger.
function recomputeCanonicalHash(row) {
  const body = {
    event_id:      row.event_id,
    event_type:    row.event_type,
    extensions: {
      'caller-governance': {
        flagged:                 row.flagged,
        invoked_by_principal_id: row.invoked_by_persona_id ?? null,
        purpose_declared:        row.purpose_declared ?? null,
        session_id:              row.session_id ?? null,
      },
    },
    occurred_at:   row.occurred_at,
    outcome:       row.outcome,
    previous_hash: row.previous_hash ?? null,
    principal_id:  row.persona_id,
    tool_name:     row.tool_name ?? null,
  };
  return crypto.createHash('sha256').update(canonicalize(body), 'utf8').digest('hex');
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
     VALUES ($1, $2, 'tool_call', 'test_hash_1', 'allowed', false, 'hash chain test')`,
    [personaId, sessionId]
  );

  // Insert second test audit event
  await pool.query(
    `INSERT INTO gif.audit_events
       (persona_id, session_id, event_type, tool_name, outcome, flagged, purpose_declared)
     VALUES ($1, $2, 'tool_call', 'test_hash_2', 'allowed', false, 'hash chain test')`,
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

  // Test 3: the DB trigger's event_hash matches an independent recomputation of
  // the gif-audit/2 canonical preimage. Fetch fields shaped exactly as the
  // verifier does: occurred_at via the same to_char(...'MS'...) the trigger uses,
  // flagged as a real boolean, plus the chained purpose_declared field.
  const rawRows = await pool.query(
    `SELECT event_id::text,
            to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at,
            persona_id::text,
            session_id::text,
            event_type,
            tool_name,
            outcome,
            flagged,
            purpose_declared,
            invoked_by_persona_id::text,
            canon_version,
            event_hash,
            previous_hash
     FROM gif.audit_events
     WHERE session_id = $1
     ORDER BY occurred_at ASC, event_id ASC`,
    [sessionId]
  );

  const raw1 = rawRows.rows[0];
  const expectedHash1 = recomputeCanonicalHash(raw1);

  if (raw1.canon_version === 'gif-audit/2') {
    pass('canon_version stamped gif-audit/2 on new rows');
  } else {
    fail('canon_version stamped gif-audit/2 on new rows', `Got: ${raw1.canon_version}`);
  }

  if (expectedHash1 === raw1.event_hash) {
    pass('event_hash matches independent SHA-256(canonicalize(body)) — gif-audit/2');
  } else {
    fail('event_hash matches independent SHA-256(canonicalize(body)) — gif-audit/2',
      `Expected: ${expectedHash1}\nGot:      ${raw1.event_hash}`);
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
