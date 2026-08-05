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

// test_audit_chain_concurrency.mjs
// =============================================================================
// Migration 016 validation: audit hash-chain writes are serialized under
// concurrent INSERTs.
//
// This is the fail-before/pass-after pair for migration 016. Against a
// pre-016 trigger, writer B does not block while writer A's row is
// uncommitted, both link the same parent, and the chain forks — tests 2–4
// fail. Against 016, B blocks on the month's gif.audit_chain_locks row
// (SELECT ... FOR UPDATE inside the trigger) and links to A's hash when it
// commits.
//
// Validates:
//   1. Writer A links to the pre-test chain tail
//   2. Writer B blocks on the chain lock while A's row is uncommitted —
//      observed as a heavyweight-lock wait in pg_stat_activity, not a timer
//   3. B stays blocked until A commits (no fork window)
//   4. After A commits, B links to A's event_hash (not A's parent) and sorts
//      strictly after A — linkage order == (occurred_at, event_id) order
//   5a. An explicit stamp in the CURRENT month is re-stamped with the server
//       clock (016 stamp posture — the trail owns occurred_at)
//   5b/5c. Chain-order floor, exercised where the re-stamp is skipped (an
//       other-month partition): a stamp at-or-before that month's tail is
//       bumped to sort strictly after the tail it links to, and a bump
//       larger than 1s raises a pg_notify on 'audit_chain_order_alert'
//   6. DEFAULT-stamped rows are re-stamped under the lock and stay monotone
//   7. Month confinement: an explicit stamp in another month's partition is
//      NOT re-stamped out of its month (no partition-constraint violation)
//
// The full-chain verifier pass over these rows happens downstream in the same
// suite run (test_chain_verifier.mjs / test_verify_integrity_e2e.mjs).
//
// Fixture note: Test 7 depends on the audit_events_2026_07 partition created
// by migration 009; it will need a new target month if that partition is ever
// retired (shared cliff with the rest of the suite's partition horizon).
//
// Isolation note: tests 1/4/5a/6 assert exact chain adjacency
// (X.previous_hash === Y.event_hash) for current-month rows written across
// separate statements — any unrelated writer on the same database landing a
// row in between produces a one-off red with an intact chain. Run against a
// database with no other live MCP traffic (CI does; a shared dev instance
// may not).
// =============================================================================

import pg from 'pg';

const { Client, Pool } = pg;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// occurred_at comparisons need microsecond precision; node-postgres returns
// timestamptz as a millisecond JS Date, so every INSERT also returns
// microseconds-since-epoch as a bigint (driver hands it back as a string —
// compare via BigInt).
const INSERT_EVENT = `
  INSERT INTO gif.audit_events
    (persona_id, session_id, event_type, tool_name, outcome, flagged, purpose_declared)
  VALUES ($1, $2, 'tool_call', $3, 'allowed', false, 'chain concurrency test')
  RETURNING event_id, event_hash, previous_hash, occurred_at,
            (extract(epoch FROM occurred_at) * 1000000)::bigint AS us`;

const pool = new Pool(dbConfig);          // observer: waits, tails, fixtures
const clientA = new Client(dbConfig);     // writer A — holds the open transaction
const clientB = new Client(dbConfig);     // writer B — must block on A's lock

console.log('\nMigration 016 — Audit Chain Concurrency Tests\n');

try {
  await clientA.connect();
  await clientB.connect();
  const bPid = (await clientB.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;

  // Hang guard: if serialization is broken in a way that wedges B forever,
  // fail the test instead of wedging the suite. Generous — normal blocking
  // in this test lasts well under a second.
  await clientB.query(`SET statement_timeout = '30s'`);

  // Fixtures: an active persona and a session, per test_hash_chain pattern.
  const personaResult = await pool.query(
    `SELECT persona_id FROM gif.personas WHERE status = 'active' LIMIT 1`
  );
  if (personaResult.rows.length === 0) {
    throw new Error('No active persona found — run earlier sprint tests first');
  }
  const personaId = personaResult.rows[0].persona_id;

  const sessionResult = await pool.query(
    `INSERT INTO gif.sessions (persona_id, invocation_context)
     VALUES ($1, $2) RETURNING session_id`,
    [personaId, JSON.stringify({ test: 'audit_chain_concurrency' })]
  );
  const sessionId = sessionResult.rows[0].session_id;

  // Pre-test tail of the current month's chain.
  const tailResult = await pool.query(
    `SELECT event_hash FROM gif.audit_events
     WHERE occurred_at >= date_trunc('month', now())
       AND occurred_at <  date_trunc('month', now()) + INTERVAL '1 month'
     ORDER BY occurred_at DESC, event_id DESC
     LIMIT 1`
  );
  const preTestTailHash = tailResult.rows[0]?.event_hash ?? null;

  // -------------------------------------------------------------------------
  // Test 1–4: two concurrent writers serialize instead of forking
  // -------------------------------------------------------------------------

  await clientA.query('BEGIN');
  const aResult = await clientA.query(INSERT_EVENT, [
    personaId, sessionId, 'test_concurrency_a',
  ]);
  const a = aResult.rows[0];
  // A's trigger has run: A now holds this month's chain lock until COMMIT.

  if (a.previous_hash === preTestTailHash) {
    pass('Writer A links to the pre-test chain tail');
  } else {
    fail('Writer A links to the pre-test chain tail',
      `previous_hash ${a.previous_hash} !== tail ${preTestTailHash}`);
  }

  // Start B while A is uncommitted. Pre-016 this INSERT completes immediately
  // and forks the chain; post-016 it blocks inside the trigger.
  let bSettled = false;
  const bPromise = clientB.query(INSERT_EVENT, [
    personaId, sessionId, 'test_concurrency_b',
  ]).finally(() => { bSettled = true; });
  // Swallow here so an assertion window can't turn into an unhandled
  // rejection; the real await below surfaces any error.
  bPromise.catch(() => {});

  // Deterministic block detection: poll pg_stat_activity until B's backend
  // reports a heavyweight-lock wait (the FOR UPDATE on the chain-lock row
  // waits on A's transaction). Same-role backends expose wait_event_type to
  // us; no blind timing assumptions. Generous ceiling (~10s) for slow CI.
  let waiterSeen = false;
  for (let i = 0; i < 200; i++) {
    const waits = await pool.query(
      `SELECT 1 FROM pg_stat_activity
       WHERE pid = $1 AND wait_event_type = 'Lock'`,
      [bPid]
    );
    if (waits.rows.length > 0) { waiterSeen = true; break; }
    if (bSettled) break;  // B finished without ever waiting — pre-016 behavior
    await sleep(50);
  }

  if (waiterSeen && !bSettled) {
    pass('Writer B blocks on the chain lock while A is uncommitted');
  } else if (bSettled) {
    fail('Writer B blocks on the chain lock while A is uncommitted',
      'B completed while A was uncommitted — unlocked prev-hash read (pre-016 fork behavior)');
  } else {
    fail('Writer B blocks on the chain lock while A is uncommitted',
      'No lock wait observed in pg_stat_activity within 10s');
  }

  // B must still be blocked right up to the commit.
  await sleep(200);
  if (!bSettled) {
    pass('Writer B stays blocked until A commits');
  } else {
    fail('Writer B stays blocked until A commits', 'B settled before A committed');
  }

  await clientA.query('COMMIT');
  const b = (await bPromise).rows[0];

  if (b.previous_hash === a.event_hash) {
    pass('Writer B links to A\'s event_hash after unblocking (no fork)');
  } else {
    fail('Writer B links to A\'s event_hash after unblocking (no fork)',
      `B.previous_hash ${b.previous_hash} !== A.event_hash ${a.event_hash}` +
      (b.previous_hash === a.previous_hash ? ' (B links A\'s parent — chain FORKED)' : ''));
  }

  if (BigInt(b.us) > BigInt(a.us)) {
    pass('Writer B sorts strictly after A (linkage order == sort order)');
  } else {
    fail('Writer B sorts strictly after A (linkage order == sort order)',
      `B at ${b.us}us !> A at ${a.us}us`);
  }

  // -------------------------------------------------------------------------
  // Test 5a: an explicit stamp in the CURRENT month is re-stamped with the
  // server clock (the 016 stamp posture) — the floor is not what fires here
  // -------------------------------------------------------------------------

  const cResult = await pool.query(
    `INSERT INTO gif.audit_events
       (persona_id, session_id, event_type, tool_name, outcome, flagged,
        purpose_declared, occurred_at)
     VALUES ($1, $2, 'tool_call', 'test_current_month_explicit', 'allowed', false,
             'chain concurrency test',
             GREATEST(date_trunc('month', now()), now() - INTERVAL '1 minute'))
     RETURNING event_hash, previous_hash, occurred_at,
               (extract(epoch FROM occurred_at) * 1000000)::bigint AS us`,
    [personaId, sessionId]
  );
  const c = cResult.rows[0];
  const cSkewMs = Math.abs(Date.now() - c.occurred_at.getTime());

  if (c.previous_hash === b.event_hash && BigInt(c.us) > BigInt(b.us) && cSkewMs < 60_000) {
    pass('Explicit current-month stamp is re-stamped to the server clock, links after tail');
  } else {
    fail('Explicit current-month stamp is re-stamped to the server clock, links after tail',
      `C.previous_hash ${c.previous_hash} vs B.event_hash ${b.event_hash}; ` +
      `C at ${c.us}us, B at ${b.us}us; skew from now ${cSkewMs}ms`);
  }

  // -------------------------------------------------------------------------
  // Test 5b/5c: chain-order floor — in an OTHER-month partition (where the
  // re-stamp is skipped), a stamp at-or-before that month's tail is bumped
  // to sort strictly after the tail it links to, and a >1s bump raises the
  // audit_chain_order_alert notification
  // -------------------------------------------------------------------------

  // Establish a tail in the 2026-07 partition (migration 009). Kept verbatim
  // on a fresh volume (empty partition); floored by microseconds against
  // residue from prior runs on a persisted volume — either way it becomes
  // the July tail at or after 07-20.
  const j1Result = await pool.query(
    `INSERT INTO gif.audit_events
       (persona_id, session_id, event_type, tool_name, outcome, flagged,
        purpose_declared, occurred_at)
     VALUES ($1, $2, 'tool_call', 'test_floor_tail', 'allowed', false,
             'chain concurrency test', '2026-07-20T12:00:00Z')
     RETURNING event_hash,
               (extract(epoch FROM occurred_at) * 1000000)::bigint AS us`,
    [personaId, sessionId]
  );
  const j1 = j1Result.rows[0];

  // clientA is idle (transaction committed) — use it as the alert listener.
  const alertReceived = new Promise((resolve) => {
    clientA.on('notification', (msg) => {
      if (msg.channel === 'audit_chain_order_alert') resolve(msg.payload);
    });
  });
  await clientA.query('LISTEN audit_chain_order_alert');

  // Five days before the July tail: the floor must bump it past j1, and the
  // ~5-day bump is far over the 1s alert threshold.
  const j2Result = await pool.query(
    `INSERT INTO gif.audit_events
       (persona_id, session_id, event_type, tool_name, outcome, flagged,
        purpose_declared, occurred_at)
     VALUES ($1, $2, 'tool_call', 'test_floor_backdated', 'allowed', false,
             'chain concurrency test', '2026-07-15T12:00:00Z')
     RETURNING event_hash, previous_hash,
               (extract(epoch FROM occurred_at) * 1000000)::bigint AS us`,
    [personaId, sessionId]
  );
  const j2 = j2Result.rows[0];

  if (j2.previous_hash === j1.event_hash && BigInt(j2.us) > BigInt(j1.us)) {
    pass('Backdated explicit stamp is floored strictly after the chain tail');
  } else {
    fail('Backdated explicit stamp is floored strictly after the chain tail',
      `J2.previous_hash ${j2.previous_hash} vs J1.event_hash ${j1.event_hash}; ` +
      `J2 at ${j2.us}us, J1 at ${j1.us}us`);
  }

  let alertTimer;
  const alertPayload = await Promise.race([
    alertReceived,
    new Promise((r) => { alertTimer = setTimeout(() => r(null), 10_000); }),
  ]);
  clearTimeout(alertTimer);
  await clientA.query('UNLISTEN audit_chain_order_alert');

  if (alertPayload && alertPayload.includes('Chain-order floor moved event')) {
    pass('Floor bump > 1s raises audit_chain_order_alert notification');
  } else if (alertPayload) {
    fail('Floor bump > 1s raises audit_chain_order_alert notification',
      `Unexpected payload: ${alertPayload}`);
  } else {
    fail('Floor bump > 1s raises audit_chain_order_alert notification',
      'No notification received within 10s');
  }

  // -------------------------------------------------------------------------
  // Test 6: DEFAULT-stamped row is re-stamped under the lock, stays monotone
  // -------------------------------------------------------------------------

  const dResult = await pool.query(INSERT_EVENT, [
    personaId, sessionId, 'test_default_stamp',
  ]);
  const d = dResult.rows[0];
  const skewMs = Math.abs(Date.now() - d.occurred_at.getTime());

  if (d.previous_hash === c.event_hash && BigInt(d.us) > BigInt(c.us) && skewMs < 60_000) {
    pass('DEFAULT-stamped row links and sorts after the floored row (re-stamped, monotone)');
  } else {
    fail('DEFAULT-stamped row links and sorts after the floored row (re-stamped, monotone)',
      `D.previous_hash ${d.previous_hash} vs C.event_hash ${c.event_hash}; ` +
      `D at ${d.us}us, C at ${c.us}us; skew from now ${skewMs}ms`);
  }

  // -------------------------------------------------------------------------
  // Test 7: month confinement — an explicit stamp in another month's
  // partition is not re-stamped out of its month
  // -------------------------------------------------------------------------

  // The 2026_07 partition exists from migration 009. The stamp is floored past
  // that month's tail if the partition already has rows; it must stay in July.
  const eResult = await pool.query(
    `INSERT INTO gif.audit_events
       (persona_id, session_id, event_type, tool_name, outcome, flagged,
        purpose_declared, occurred_at)
     VALUES ($1, $2, 'tool_call', 'test_cross_month', 'allowed', false,
             'chain concurrency test', '2026-07-15T12:00:00Z')
     RETURNING occurred_at,
               to_char(date_trunc('month', occurred_at), 'YYYY-MM') AS month`,
    [personaId, sessionId]
  );
  const e = eResult.rows[0];

  if (e.month === '2026-07') {
    pass('Explicit other-month stamp stays in its partition month (no cross-month re-stamp)');
  } else {
    fail('Explicit other-month stamp stays in its partition month (no cross-month re-stamp)',
      `Stored month ${e.month}, expected 2026-07`);
  }

  // Cleanup (sessions are mutable; audit rows are append-only and stay).
  await pool.query(
    `UPDATE gif.sessions SET ended_at = now() WHERE session_id = $1`,
    [sessionId]
  );

} catch (err) {
  console.error('Test error:', err.message);
  failed++;
  try { await clientA.query('ROLLBACK'); } catch { /* txn may not be open */ }
} finally {
  await clientA.end().catch(() => {});
  await clientB.end().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
