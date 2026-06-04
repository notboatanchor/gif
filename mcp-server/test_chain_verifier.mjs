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

// test_chain_verifier.mjs
// =============================================================================
// Tests for the audit chain verifier (verify_audit_chain.ts).
//
// Structure:
//   Part 1 — Pure-core unit tests (no DB). Uses replicated pure functions
//             matching the trigger's preimage contract exactly. Exercises:
//               (a) clean 3-row chain → 0 anomalies
//               (b) tampered field (event_type) → recompute mismatch detected
//               (c) dropped middle row → linkage break detected
//               (d) HASH_ERROR sentinel → categorized as hash_error, not mismatch
//               (e) anchor with stale anchor_hash → anchor failure detected
//
//   Part 2 — Live integration (requires DB). Seeds 3 real audit events for one
//             session via gif_app pool (trigger chains them), runs the fetch +
//             verify path over the live DB using the same query the CLI uses,
//             asserts 0 mismatches and 0 breaks. Cleans up by closing the session.
//
// Run from gif/mcp-server/ with DB creds in env:
//   set -a; . ../.env; set +a; node test_chain_verifier.mjs
// =============================================================================

import pg from 'pg';
import crypto from 'crypto';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Pass/fail bookkeeping
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function pass(label) {
  console.log(`  ✓ ${label}`);
  passed++;
}

function fail(label, detail) {
  console.error(`  ✗ ${label}`);
  if (detail !== undefined) console.error(`    ${detail}`);
  failed++;
}

// ---------------------------------------------------------------------------
// Pure functions — replicated from verify_audit_chain.ts for plain-node
// testability (no build step needed). Must stay byte-identical to the trigger's
// preimage contract and to the .ts implementation.
//
// Preimage: concat_ws('|') with COALESCE on session_id, tool_name, previous_hash.
// All non-nullable fields are their Postgres ::text values.
// ---------------------------------------------------------------------------

function buildPreimage(row, storedPreviousHash) {
  return [
    row.event_id,
    row.occurred_at,
    row.persona_id,
    row.session_id   ?? 'NULL',
    row.event_type,
    row.tool_name    ?? 'NULL',
    row.outcome,
    row.flagged,
    storedPreviousHash ?? 'NULL',
  ].join('|');
}

function recomputeHash(row) {
  const preimage = buildPreimage(row, row.previous_hash);
  return crypto.createHash('sha256').update(preimage, 'utf8').digest('hex');
}

// verifyPartition: mirrors the .ts implementation exactly.
function verifyPartition(partitionKey, rows) {
  const result = {
    partition:       partitionKey,
    total_rows:      rows.length,
    hashed_checked:  0,
    links_verified:  0,
    mismatches:      [],
    breaks:          [],
    hash_errors:     [],
    legacy_null:     0,
  };

  let prevHashedHash = null;
  let isFirstHashed  = true;

  for (const row of rows) {
    if (row.event_hash === null) {
      result.legacy_null++;
      continue;
    }

    if (row.event_hash === 'HASH_ERROR') {
      result.hash_errors.push(row.event_id);
      // HASH_ERROR advances the chain pointer: the trigger stores 'HASH_ERROR' as
      // event_hash, so the next row's trigger reads 'HASH_ERROR' as prev_hash and
      // writes it into that row's previous_hash.
      prevHashedHash = 'HASH_ERROR';
      isFirstHashed  = false;
      continue;
    }

    result.hashed_checked++;

    const expected = recomputeHash(row);
    if (expected !== row.event_hash) {
      result.mismatches.push(row.event_id);
      prevHashedHash = row.event_hash;
      isFirstHashed  = false;
      continue;
    }

    if (isFirstHashed) {
      result.links_verified++;
      isFirstHashed = false;
    } else {
      if (row.previous_hash === prevHashedHash) {
        result.links_verified++;
      } else {
        result.breaks.push(row.event_id);
      }
    }

    prevHashedHash = row.event_hash;
  }

  return result;
}

// verifyAnchors: mirrors the .ts implementation.
function verifyAnchors(anchors, liveHashLookup, liveCountLookup) {
  return anchors.map(anchor => {
    const liveHash  = liveHashLookup.get(anchor.event_id);
    const liveCount = liveCountLookup.get(anchor.partition_name) ?? 0;

    if (liveHash === undefined) {
      return { ...anchor, status: 'event_not_found', detail: 'event_id not found' };
    }
    if (liveHash !== anchor.anchor_hash) {
      return { ...anchor, status: 'hash_mismatch', detail: `stored ${anchor.anchor_hash} ≠ live ${liveHash}` };
    }
    if (liveCount < anchor.event_count) {
      return { ...anchor, status: 'shrunk', detail: `live count ${liveCount} < anchored ${anchor.event_count}` };
    }
    return { ...anchor, status: 'ok', detail: 'ok' };
  });
}

function verifyChain(partitionMap, anchors, liveHashLookup, liveCountLookup) {
  const partitions = [];
  for (const [key, rows] of partitionMap) {
    partitions.push(verifyPartition(key, rows));
  }

  const anchorResults =
    anchors !== null && liveHashLookup && liveCountLookup
      ? verifyAnchors(anchors, liveHashLookup, liveCountLookup)
      : null;

  const total_mismatches   = partitions.reduce((s, p) => s + p.mismatches.length, 0);
  const total_breaks       = partitions.reduce((s, p) => s + p.breaks.length, 0);
  const total_hash_errors  = partitions.reduce((s, p) => s + p.hash_errors.length, 0);
  const total_anchor_fails = anchorResults
    ? anchorResults.filter(a => a.status !== 'ok').length
    : 0;

  return {
    partitions,
    anchors: anchorResults,
    total_mismatches,
    total_breaks,
    total_hash_errors,
    total_anchor_fails,
    ok: total_mismatches === 0 && total_breaks === 0 && total_anchor_fails === 0,
  };
}

// ---------------------------------------------------------------------------
// Synthetic chain builder — produces rows with correct hashes without a DB.
//
// Simulates exactly what the Postgres trigger does: for each row, compute
// the SHA-256 of the preimage using the previous row's event_hash as
// previous_hash. Fields are pre-cast string values, matching ::text output.
//
// All UUIDs are deterministic fakes for reproducibility.
// ---------------------------------------------------------------------------

const PERSONA_ID = '00000000-0000-0000-0000-000000000001';
const SESSION_ID = '00000000-0000-0000-0000-000000000002';

function makeSyntheticRow(overrides, prevEventHash) {
  const base = {
    event_id:      crypto.randomUUID(),
    occurred_at:   '2026-06-03 10:00:00+00',
    persona_id:    PERSONA_ID,
    session_id:    SESSION_ID,
    event_type:    'tool_call',
    tool_name:     'test_tool',
    outcome:       'success',
    flagged:       'false',
    ...overrides,
  };

  // Compute the hash the trigger would compute.
  const preimage = buildPreimage(base, prevEventHash ?? null);
  const event_hash = crypto.createHash('sha256').update(preimage, 'utf8').digest('hex');

  return {
    ...base,
    previous_hash: prevEventHash ?? null,
    event_hash,
  };
}

function buildCleanChain() {
  const row1 = makeSyntheticRow({ event_id: 'aaaaaaaa-0000-0000-0000-000000000001' }, null);
  const row2 = makeSyntheticRow({ event_id: 'aaaaaaaa-0000-0000-0000-000000000002' }, row1.event_hash);
  const row3 = makeSyntheticRow({ event_id: 'aaaaaaaa-0000-0000-0000-000000000003' }, row2.event_hash);
  return [row1, row2, row3];
}

// ===========================================================================
// Part 1 — Pure-core unit tests
// ===========================================================================

console.log('\nChain Verifier — Part 1: Pure-Core Unit Tests\n');

// ---------------------------------------------------------------------------
// Test 1(a): clean 3-row chain → 0 anomalies
// ---------------------------------------------------------------------------

{
  const rows = buildCleanChain();
  const map  = new Map([['2026-06-01T00:00:00.000Z', rows]]);
  const r    = verifyChain(map, null);

  if (r.total_mismatches === 0) {
    pass('(a) clean chain: 0 mismatches');
  } else {
    fail('(a) clean chain: 0 mismatches', `got ${r.total_mismatches}`);
  }

  if (r.total_breaks === 0) {
    pass('(a) clean chain: 0 linkage breaks');
  } else {
    fail('(a) clean chain: 0 linkage breaks', `got ${r.total_breaks}`);
  }

  if (r.partitions[0].hashed_checked === 3) {
    pass('(a) clean chain: all 3 rows hashed and checked');
  } else {
    fail('(a) clean chain: all 3 rows hashed and checked', `hashed_checked=${r.partitions[0].hashed_checked}`);
  }

  if (r.ok) {
    pass('(a) clean chain: result.ok is true');
  } else {
    fail('(a) clean chain: result.ok is true', 'ok=false');
  }
}

// ---------------------------------------------------------------------------
// Test 1(b): tamper row2's event_type without updating its event_hash →
//            recompute mismatch detected for exactly row2
// ---------------------------------------------------------------------------

{
  const [row1, row2, row3] = buildCleanChain();
  // Alter row2's event_type without recomputing event_hash — simulates a
  // superuser UPDATE after the trigger already wrote the hash.
  const tamperedRow2 = { ...row2, event_type: 'TAMPERED_TYPE' };

  const rows = [row1, tamperedRow2, row3];
  const map  = new Map([['2026-06-01T00:00:00.000Z', rows]]);
  const r    = verifyChain(map, null);

  if (r.total_mismatches === 1) {
    pass('(b) tampered event_type: exactly 1 mismatch detected');
  } else {
    fail('(b) tampered event_type: exactly 1 mismatch detected', `got ${r.total_mismatches}`);
  }

  const p = r.partitions[0];
  if (p.mismatches.length === 1 && p.mismatches[0] === row2.event_id) {
    pass('(b) tampered event_type: mismatch is on the correct event_id (row2)');
  } else {
    fail('(b) tampered event_type: mismatch is on the correct event_id (row2)',
         `mismatches=${JSON.stringify(p.mismatches)}, row2.event_id=${row2.event_id}`);
  }

  if (!r.ok) {
    pass('(b) tampered event_type: result.ok is false');
  } else {
    fail('(b) tampered event_type: result.ok is false', 'ok=true unexpectedly');
  }
}

// ---------------------------------------------------------------------------
// Test 1(c): drop the middle row (row2) → linkage break on row3
// ---------------------------------------------------------------------------

{
  const [row1, , row3] = buildCleanChain();
  // row3.previous_hash points to row2's event_hash, but row2 is absent.
  // The verifier should see that row3.previous_hash ≠ row1.event_hash → break.
  const rows = [row1, row3];
  const map  = new Map([['2026-06-01T00:00:00.000Z', rows]]);
  const r    = verifyChain(map, null);

  if (r.total_breaks === 1) {
    pass('(c) dropped middle row: exactly 1 linkage break detected');
  } else {
    fail('(c) dropped middle row: exactly 1 linkage break detected', `got ${r.total_breaks}`);
  }

  const p = r.partitions[0];
  if (p.breaks.length === 1 && p.breaks[0] === row3.event_id) {
    pass('(c) dropped middle row: break is on the correct event_id (row3)');
  } else {
    fail('(c) dropped middle row: break is on the correct event_id (row3)',
         `breaks=${JSON.stringify(p.breaks)}, row3.event_id=${row3.event_id}`);
  }

  if (!r.ok) {
    pass('(c) dropped middle row: result.ok is false');
  } else {
    fail('(c) dropped middle row: result.ok is false', 'ok=true unexpectedly');
  }

  if (r.total_mismatches === 0) {
    pass('(c) dropped middle row: no false mismatch on row3 (linkage error, not field tamper)');
  } else {
    fail('(c) dropped middle row: no false mismatch on row3', `mismatches=${r.total_mismatches}`);
  }
}

// ---------------------------------------------------------------------------
// Test 1(d): HASH_ERROR sentinel row → categorized as hash_error, NOT mismatch
// ---------------------------------------------------------------------------

{
  const [row1, row2] = buildCleanChain();
  // Replace row2 with a HASH_ERROR sentinel (as the trigger would on hash
  // compute failure). event_hash = 'HASH_ERROR'; previous_hash = row1.event_hash.
  const hashErrorRow = { ...row2, event_hash: 'HASH_ERROR', previous_hash: row1.event_hash };

  // row3 must reflect what the trigger would actually produce after a HASH_ERROR
  // row: the trigger SELECTs the most recent event_hash (= 'HASH_ERROR') and
  // stores it as row3.previous_hash. Recompute row3's hash accordingly.
  const row3 = makeSyntheticRow(
    { event_id: 'aaaaaaaa-0000-0000-0000-000000000003' },
    'HASH_ERROR',  // the trigger's prev_hash lookup returns 'HASH_ERROR'
  );

  const rows = [row1, hashErrorRow, row3];
  const map  = new Map([['2026-06-01T00:00:00.000Z', rows]]);
  const r    = verifyChain(map, null);

  const p = r.partitions[0];

  if (p.hash_errors.length === 1 && p.hash_errors[0] === row2.event_id) {
    pass('(d) HASH_ERROR sentinel: categorized in hash_errors, not mismatches');
  } else {
    fail('(d) HASH_ERROR sentinel: categorized in hash_errors, not mismatches',
         `hash_errors=${JSON.stringify(p.hash_errors)}, mismatches=${JSON.stringify(p.mismatches)}`);
  }

  if (p.mismatches.length === 0) {
    pass('(d) HASH_ERROR sentinel: no false mismatch reported');
  } else {
    fail('(d) HASH_ERROR sentinel: no false mismatch reported', `mismatches=${JSON.stringify(p.mismatches)}`);
  }

  // HASH_ERROR does NOT set ok=false per the spec (warning only, not tamper).
  if (r.ok) {
    pass('(d) HASH_ERROR sentinel: result.ok remains true (write-time warning, not tamper)');
  } else {
    fail('(d) HASH_ERROR sentinel: result.ok remains true (write-time warning, not tamper)', 'ok=false');
  }
}

// ---------------------------------------------------------------------------
// Test 1(e): anchor whose anchor_hash no longer matches → anchor failure
// ---------------------------------------------------------------------------

{
  const [row1] = buildCleanChain();

  // Anchor pointing to row1 with a stale (wrong) hash.
  const staleAnchor = {
    anchor_id:      'bbbbbbbb-0000-0000-0000-000000000001',
    event_id:       row1.event_id,
    anchor_hash:    'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    partition_name: 'audit_events_2026_06',
    event_count:    1,
    anchored_by:    'test',
  };

  // liveHashLookup has the real (different) hash for row1's event_id.
  const liveHashLookup  = new Map([[row1.event_id, row1.event_hash]]);
  const liveCountLookup = new Map([['audit_events_2026_06', 1]]);

  const map = new Map([['2026-06-01T00:00:00.000Z', [row1]]]);
  const r   = verifyChain(map, [staleAnchor], liveHashLookup, liveCountLookup);

  if (r.total_anchor_fails === 1) {
    pass('(e) stale anchor: anchor failure detected (total_anchor_fails=1)');
  } else {
    fail('(e) stale anchor: anchor failure detected', `total_anchor_fails=${r.total_anchor_fails}`);
  }

  const af = r.anchors[0];
  if (af.status === 'hash_mismatch') {
    pass('(e) stale anchor: status is hash_mismatch');
  } else {
    fail('(e) stale anchor: status is hash_mismatch', `got status=${af.status}`);
  }

  if (!r.ok) {
    pass('(e) stale anchor: result.ok is false');
  } else {
    fail('(e) stale anchor: result.ok is false', 'ok=true unexpectedly');
  }
}

// Also test the 'shrunk' anchor failure path.
{
  const [row1] = buildCleanChain();

  // Anchor says 100 rows, but live count is only 3.
  const shrinkAnchor = {
    anchor_id:      'bbbbbbbb-0000-0000-0000-000000000002',
    event_id:       row1.event_id,
    anchor_hash:    row1.event_hash,  // hash still matches
    partition_name: 'audit_events_2026_06',
    event_count:    100,
    anchored_by:    'test',
  };

  const liveHashLookup  = new Map([[row1.event_id, row1.event_hash]]);
  const liveCountLookup = new Map([['audit_events_2026_06', 3]]);  // < 100

  const map = new Map([['2026-06-01T00:00:00.000Z', [row1]]]);
  const r   = verifyChain(map, [shrinkAnchor], liveHashLookup, liveCountLookup);

  const af = r.anchors?.[0];
  if (af?.status === 'shrunk') {
    pass('(e) shrunk partition: anchor status is shrunk');
  } else {
    fail('(e) shrunk partition: anchor status is shrunk', `status=${af?.status}`);
  }
}

// ===========================================================================
// Part 2 — Live integration test
// ===========================================================================

console.log('\nChain Verifier — Part 2: Live Integration\n');

const dbConfig = {
  host:     process.env.PGHOST     || 'localhost',
  port:     parseInt(process.env.PGPORT || '5432'),
  user:     process.env.PGUSER     || 'gif_app',
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'gif',
};

const pool = new Pool(dbConfig);

let liveSkipped = false;

try {
  // Quick connectivity check — abort gracefully if DB is not available.
  await pool.query('SELECT 1');
} catch (err) {
  console.log(`  ⚠ DB unreachable (${err.message}) — skipping live integration tests.`);
  console.log('  Pure-core unit tests above are definitive for tamper detection logic.');
  liveSkipped = true;
}

if (!liveSkipped) {
  let sessionId = null;

  try {
    // Find an active approved persona to use for seeding.
    const personaResult = await pool.query(
      `SELECT persona_id FROM gif.personas WHERE status = 'active' LIMIT 1`,
    );
    if (personaResult.rows.length === 0) {
      throw new Error('No active persona found — run test_setup.mjs first');
    }
    const personaId = personaResult.rows[0].persona_id;

    // Create a session for the test events.
    const sessionResult = await pool.query(
      `INSERT INTO gif.sessions (persona_id, invocation_context)
       VALUES ($1, $2) RETURNING session_id`,
      [personaId, JSON.stringify({ test: 'chain_verifier_integration' })],
    );
    sessionId = sessionResult.rows[0].session_id;

    // Seed 3 audit events — the trigger chains them automatically.
    for (let i = 1; i <= 3; i++) {
      await pool.query(
        `INSERT INTO gif.audit_events
           (persona_id, session_id, event_type, tool_name, outcome, flagged, purpose_declared)
         VALUES ($1, $2, 'tool_call', $3, 'success', false, 'chain_verifier_integration_test')`,
        [personaId, sessionId, `chain_verifier_seed_${i}`],
      );
    }

    // Fetch the seeded events using the exact same query as the CLI's DB shell,
    // keyed by session_id for isolation. Use ::text casts to match the preimage.
    const rawResult = await pool.query(
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
      [sessionId],
    );

    if (rawResult.rows.length < 3) {
      throw new Error(`Expected 3 seeded rows, got ${rawResult.rows.length}`);
    }

    // Group into a single-partition map (all events share the same session).
    // Use the first row's occurred_at month as the partition key.
    const firstRow   = rawResult.rows[0];
    const monthMatch = firstRow.occurred_at.match(/^(\d{4}-\d{2})/);
    const partKey    = monthMatch ? `${monthMatch[1]}-01T00:00:00.000Z` : 'live_partition';

    const partitionMap = new Map([[partKey, rawResult.rows]]);
    const result       = verifyChain(partitionMap, null);

    if (result.total_mismatches === 0) {
      pass('live integration: 0 hash mismatches on seeded chain');
    } else {
      fail('live integration: 0 hash mismatches on seeded chain',
           `${result.total_mismatches} mismatch(es): ${JSON.stringify(result.partitions[0]?.mismatches)}`);
    }

    if (result.total_breaks === 0) {
      pass('live integration: 0 linkage breaks on seeded chain');
    } else {
      fail('live integration: 0 linkage breaks on seeded chain',
           `${result.total_breaks} break(s): ${JSON.stringify(result.partitions[0]?.breaks)}`);
    }

    if (result.partitions[0]?.hashed_checked === 3) {
      pass('live integration: all 3 seeded rows hashed and verified');
    } else {
      fail('live integration: all 3 seeded rows hashed and verified',
           `hashed_checked=${result.partitions[0]?.hashed_checked}`);
    }

    if (result.ok) {
      pass('live integration: verifyChain result.ok is true');
    } else {
      fail('live integration: verifyChain result.ok is true', 'ok=false');
    }

    // Also confirm the chain linkage manually: row2.previous_hash = row1.event_hash.
    const [r1, r2, r3] = rawResult.rows;
    if (r2.previous_hash === r1.event_hash) {
      pass('live integration: row2.previous_hash === row1.event_hash (chain linked)');
    } else {
      fail('live integration: row2.previous_hash === row1.event_hash',
           `r2.previous_hash=${r2.previous_hash}, r1.event_hash=${r1.event_hash}`);
    }

    if (r3.previous_hash === r2.event_hash) {
      pass('live integration: row3.previous_hash === row2.event_hash (chain linked)');
    } else {
      fail('live integration: row3.previous_hash === row2.event_hash',
           `r3.previous_hash=${r3.previous_hash}, r2.event_hash=${r2.event_hash}`);
    }

    // Cleanup: close the session (gif_app can UPDATE sessions.ended_at;
    // audit_events is append-only and not touched). Mirror test_hash_chain.mjs.
    await pool.query(
      `UPDATE gif.sessions SET ended_at = now() WHERE session_id = $1`,
      [sessionId],
    );

  } catch (err) {
    console.error('  Live integration error:', err.message);
    failed++;
    // Best-effort cleanup.
    if (sessionId) {
      await pool.query(
        `UPDATE gif.sessions SET ended_at = now() WHERE session_id = $1`,
        [sessionId],
      ).catch(() => {});
    }
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// Final summary
// ---------------------------------------------------------------------------

console.log('');
console.log(`${passed + failed} tests — ${passed} passed, ${failed} failed`);
if (liveSkipped) {
  console.log('(live integration skipped — DB unavailable)');
}
console.log('');

if (failed > 0) process.exit(1);
