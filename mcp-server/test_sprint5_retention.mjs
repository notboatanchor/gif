// test_sprint5_retention.mjs
// =============================================================================
// Sprint 5 validation: retention lifecycle (migration 009).
//
// Validates:
//   1. retention_holds INSERT and SELECT work for gif_app
//   2. gif_app cannot UPDATE retention_holds (cannot release own holds)
//   3. retire_partition is blocked when an active hold exists
//   4. retire_partition proceeds after hold is released (gif_admin releases)
//      and inserts an erasure_log row
//   5. New partitions 2026_07 through 2026_12 exist and accept INSERTs
// =============================================================================

import pg from 'pg';

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
// Main
// ---------------------------------------------------------------------------

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
  user:     process.env.PGADMINUSER     || 'scott',
  password: process.env.PGADMINPASSWORD,
  database: process.env.PGDATABASE      || 'gif',
});

console.log('\nSprint 5 — Retention Lifecycle Tests\n');

try {
  // Get a persona for hold target
  const personaResult = await gifPool.query(
    `SELECT persona_id FROM gif.personas WHERE status = 'active' LIMIT 1`
  );
  if (personaResult.rows.length === 0) throw new Error('No active persona found');
  const personaId = personaResult.rows[0].persona_id;

  // Test 1: retention_holds INSERT works for gif_app
  const holdResult = await gifPool.query(
    `INSERT INTO gif.retention_holds
       (created_by, persona_id, hold_reason, legal_matter_ref)
     VALUES ('test_sprint5', $1, 'Sprint 5 retention test hold', 'TEST-SPRINT5')
     RETURNING hold_id`,
    [personaId]
  );
  const holdId = holdResult.rows[0]?.hold_id;

  if (holdId) {
    pass('retention_holds INSERT works for gif_app');
  } else {
    fail('retention_holds INSERT works for gif_app', 'No hold_id returned');
  }

  // Test 2: retention_holds SELECT works for gif_app
  const selectCheck = await gifPool.query(
    `SELECT hold_id FROM gif.retention_holds WHERE hold_id = $1`, [holdId]
  );
  if (selectCheck.rows.length > 0) {
    pass('retention_holds SELECT works for gif_app');
  } else {
    fail('retention_holds SELECT works for gif_app', 'Hold not found after insert');
  }

  // Test 3: gif_app cannot UPDATE retention_holds (cannot release hold)
  try {
    await gifPool.query(
      `UPDATE gif.retention_holds
       SET released_at = now(), released_by = 'attacker', release_reason = 'bypass'
       WHERE hold_id = $1`,
      [holdId]
    );
    fail('gif_app cannot UPDATE retention_holds', 'UPDATE succeeded — should be denied');
  } catch (e) {
    if (e.message.includes('permission') || e.message.includes('denied') ||
        e.message.includes('UPDATE') || e.message.includes('policy')) {
      pass('gif_app cannot UPDATE retention_holds (no UPDATE grant)');
    } else {
      fail('gif_app cannot UPDATE retention_holds', `Unexpected error: ${e.message}`);
    }
  }

  // Test 4: retire_partition is blocked when an active hold exists
  // We need a test partition with events for the hold target persona.
  // Create a temporary test partition to avoid touching real data.
  const testPartitionName = 'audit_events_test_retention_sprint5';

  // Create a scratch partition (far future range that won't conflict)
  await pgPool.query(
    `CREATE TABLE IF NOT EXISTS gif.${testPartitionName}
     PARTITION OF gif.audit_events
     FOR VALUES FROM ('2099-01-01') TO ('2099-02-01')`
  );

  // Insert a test event into it as postgres (bypasses RLS)
  await pgPool.query(
    `INSERT INTO gif.audit_events
       (persona_id, event_type, tool_name, outcome, flagged, occurred_at)
     VALUES ($1, 'tool_call', 'test_retention', 'success', false, '2099-01-15 12:00:00+00')`,
    [personaId]
  );

  // Attempt retire_partition with an active hold on the persona — should fail
  try {
    await pgPool.query(
      `CALL gif.retire_partition($1, 'test_operator', 'test retirement', NULL)`,
      [testPartitionName]
    );
    fail('retire_partition blocked by active hold', 'Procedure succeeded — should have raised exception');
  } catch (e) {
    if (e.message.includes('hold') || e.message.includes('blocked') || e.message.includes('active')) {
      pass('retire_partition raises exception when active hold exists');
    } else {
      fail('retire_partition raises exception when active hold exists', `Unexpected error: ${e.message}`);
    }
  }

  // Test 5: retire_partition succeeds after hold is released
  // Release the hold as gif_admin (pgPool connects as postgres)
  await pgPool.query(
    `UPDATE gif.retention_holds
     SET released_at = now(), released_by = 'test_postgres', release_reason = 'test release'
     WHERE hold_id = $1`,
    [holdId]
  );

  const erasureCountBefore = await pgPool.query(
    `SELECT count(*) AS cnt FROM gif.erasure_log`
  );
  const beforeCount = parseInt(erasureCountBefore.rows[0].cnt);

  await pgPool.query(
    `CALL gif.retire_partition($1, 'test_operator', 'Sprint 5 retention test — post-hold release', 'TEST-SPRINT5')`,
    [testPartitionName]
  );

  pass('retire_partition succeeds after hold is released');

  // Verify erasure_log row was inserted
  const erasureCheck = await pgPool.query(
    `SELECT erasure_id, rows_deleted, erasure_reason FROM gif.erasure_log
     ORDER BY erased_at DESC LIMIT 1`
  );
  const afterCount = parseInt((await pgPool.query(`SELECT count(*) AS cnt FROM gif.erasure_log`)).rows[0].cnt);

  if (afterCount > beforeCount) {
    pass('retire_partition auto-inserts erasure_log row');
  } else {
    fail('retire_partition auto-inserts erasure_log row', 'No new erasure_log row after retirement');
  }

  // Verify the test partition was actually dropped
  const partitionCheck = await pgPool.query(
    `SELECT 1 FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = $1 AND n.nspname = 'gif'`,
    [testPartitionName]
  );
  if (partitionCheck.rows.length === 0) {
    pass('Partition is dropped after retire_partition');
  } else {
    fail('Partition is dropped after retire_partition', 'Partition still exists in pg_class');
  }

  // Test 6: new partitions 2026_07 through 2026_12 exist and accept INSERTs
  const newPartitions = [
    '2026_07', '2026_08', '2026_09', '2026_10', '2026_11', '2026_12',
  ];

  let partitionsPassing = 0;
  for (const suffix of newPartitions) {
    const partName = `audit_events_${suffix}`;
    const exists = await pgPool.query(
      `SELECT 1 FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relname = $1 AND n.nspname = 'gif'`,
      [partName]
    );
    if (exists.rows.length > 0) partitionsPassing++;
  }

  if (partitionsPassing === 6) {
    pass('All 6 new partitions (2026_07 through 2026_12) exist');
  } else {
    fail('All 6 new partitions (2026_07 through 2026_12) exist',
      `Only ${partitionsPassing}/6 found`);
  }

  // Test INSERT into a new partition (2026_07)
  const futureSession = await gifPool.query(
    `INSERT INTO gif.sessions (persona_id, invocation_context)
     VALUES ($1, '{"test": "sprint5_retention"}') RETURNING session_id`,
    [personaId]
  );
  const futureSessionId = futureSession.rows[0].session_id;

  try {
    await pgPool.query(
      `INSERT INTO gif.audit_events
         (persona_id, session_id, event_type, tool_name, outcome, flagged, occurred_at)
       VALUES ($1, $2, 'tool_call', 'test_future_partition', 'success', false, '2026-07-15 12:00:00+00')`,
      [personaId, futureSessionId]
    );
    pass('INSERT into audit_events_2026_07 succeeds');
  } catch (e) {
    fail('INSERT into audit_events_2026_07 succeeds', e.message);
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
