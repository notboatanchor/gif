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

// test_shutdown_drain.mjs
// =============================================================================
// Shutdown drain: SIGTERM/SIGINT must not lose in-flight audit writes.
//
// Validates (against a locally spawned `node dist/index.js`, NOT the compose
// container — this test exercises process lifecycle, which needs signal and
// stdio access):
//   A. An audit INSERT orphaned by a client disconnect survives SIGTERM: the
//      server stays up until the write lands, then exits 0, and the row is
//      present. Pre-fix behavior: with the client connection gone,
//      httpServer.close()'s callback fired immediately and process.exit(0)
//      killed the INSERT mid-flight — a silent audit row drop.
//   B. The drain is bounded: with GIF_SHUTDOWN_TIMEOUT_SECONDS=2 and an audit
//      write that cannot complete, the server force-exits nonzero (code 1)
//      with a loud log line. (The row MAY still land server-side — Postgres
//      can commit a statement whose client died — so no row assertion here.)
//   C. Clean idle shutdown on SIGINT: exit 0, "Shutdown complete" logged.
//   D. Boot-fail on an oversized GIF_SHUTDOWN_TIMEOUT_SECONDS: values whose
//      millisecond product exceeds 2^31-1 would be clamped by setTimeout to
//      ~1ms — firing the force-exit immediately and inverting the drain
//      guarantee — so startup must reject them fail-fast.
//   E. Second signal during a drain force-exits immediately (code 1, loud):
//      the operator escape hatch that replaces silent SIGKILL.
//
// Determinism fixture: the audit INSERT is stalled by holding FOR UPDATE on
// the current month's row of gif.audit_chain_locks (migration 016) from a
// gif_admin connection — the hash-chain trigger serializes on that row, so
// the child's INSERT blocks exactly at the drain point under test. Holding
// the lock blocks ALL audit writes on this database; the suite runs tests
// sequentially, so nothing else is writing.
//
// Visibility note: the blocked INSERT is detected via pg_stat_activity from a
// gif_app connection — same role as the child's pool, so query text and
// wait_event_type are visible (they are masked across roles for
// non-superusers).
//
// Requires: dist/ built (pretest), migrations through 016 applied, an active
// approved persona seeded by earlier suite tests (test_setup.mjs).
// =============================================================================

import { spawn } from 'child_process';
import http from 'http';
import pg from 'pg';

const { Pool, Client } = pg;

const appConfig = {
  host:     process.env.PGHOST     || 'localhost',
  port:     parseInt(process.env.PGPORT || '5432'),
  user:     process.env.PGUSER     || 'gif_app',
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'gif',
};

const adminConfig = {
  ...appConfig,
  user:     'gif_admin',
  password: process.env.PGADMINPASSWORD,
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Poll fn() every intervalMs until it returns truthy or timeoutMs elapses.
async function waitFor(fn, { timeoutMs = 10000, intervalMs = 50, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

// ---------------------------------------------------------------------------
// Child server management
// ---------------------------------------------------------------------------

function spawnServer(port, extraEnv = {}) {
  const child = spawn(process.execPath, ['dist/index.js'], {
    env: { ...process.env, PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (d) => { out.stdout += d; });
  child.stderr.on('data', (d) => { out.stderr += d; });
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => { resolve({ code, signal }); });
  });
  return { child, out, exited };
}

async function waitForHealth(port) {
  await waitFor(async () => {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }, { timeoutMs: 15000, intervalMs: 100, label: `child server /health on :${port}` });
}

// Fire a tools/call session_start as a raw HTTP POST and return the request
// object so the caller can destroy the socket mid-call. Errors after destroy
// are expected and swallowed.
function postSessionStart(port, personaId) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id:      1,
    method:  'tools/call',
    params:  {
      name:      'session_start',
      arguments: { persona_id: personaId },
    },
  });
  const req = http.request({
    host:    'localhost',
    port,
    path:    '/mcp',
    method:  'POST',
    headers: {
      'Content-Type':   'application/json',
      'Accept':         'application/json, text/event-stream',
      'Content-Length': Buffer.byteLength(body),
    },
  });
  req.on('error', () => { /* expected after req.destroy() */ });
  req.on('response', (res) => { res.resume(); });
  req.write(body);
  req.end();
  return req;
}

// ---------------------------------------------------------------------------
// Chain-lock fixture (migration 016)
// ---------------------------------------------------------------------------

// Ensure the current UTC month's lock row exists, then hold FOR UPDATE on it
// in an open transaction. Returns when the lock is held.
async function acquireChainLock(adminClient) {
  await adminClient.query(
    `INSERT INTO gif.audit_chain_locks (month_start)
          VALUES (date_trunc('month', now()))
     ON CONFLICT (month_start) DO NOTHING`
  );
  await adminClient.query('BEGIN');
  await adminClient.query(
    `SELECT month_start FROM gif.audit_chain_locks
      WHERE month_start = date_trunc('month', now())
        FOR UPDATE`
  );
}

async function releaseChainLock(adminClient) {
  await adminClient.query('ROLLBACK');
}

// The child's audit INSERT, blocked on the chain lock, seen from a gif_app
// connection (same role as the child's pool — query text is visible).
async function auditInsertIsBlocked(appPool) {
  const res = await appPool.query(
    `SELECT count(*)::int AS n
       FROM pg_stat_activity
      WHERE state = 'active'
        AND wait_event_type = 'Lock'
        AND query LIKE '%INSERT INTO audit_events%'
        AND pid <> pg_backend_pid()`
  );
  return res.rows[0].n > 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const PORT_A = parseInt(process.env.TEST_SHUTDOWN_PORT || '3397');
const PORT_B = PORT_A + 1;
const PORT_C = PORT_A + 2;
const PORT_E = PORT_A + 3;

const appPool = new Pool({ ...appConfig, max: 2 });
const adminClient = new Client(adminConfig);

console.log('\n=== Shutdown drain (SIGTERM/SIGINT audit flush) ===\n');

let serverA = null;
let serverB = null;
let serverC = null;
let serverD = null;
let serverE = null;
let lockHeld = false;

try {
  await adminClient.connect();
  // The trigger truncates months under TZ=UTC (migration 016); match it so
  // the FOR UPDATE lands on the same row the trigger serializes on.
  await adminClient.query(`SET TIME ZONE 'UTC'`);

  const personaResult = await appPool.query(
    `SELECT persona_id FROM gif.personas
      WHERE status = 'active' AND governance_review_status = 'approved'
      ORDER BY created_at LIMIT 1`
  );
  if (personaResult.rows.length === 0) {
    throw new Error('No active approved persona found — run test_setup.mjs first');
  }
  const personaId = personaResult.rows[0].persona_id;

  // -------------------------------------------------------------------------
  // A. Disconnect-orphaned audit write survives SIGTERM
  // -------------------------------------------------------------------------
  console.log('A. Disconnect-orphaned audit write survives SIGTERM');

  const beforeCount = (await appPool.query(
    `SELECT count(*)::int AS n FROM gif.audit_events
      WHERE persona_id = $1 AND event_type = 'session_start'`,
    [personaId]
  )).rows[0].n;

  await acquireChainLock(adminClient);
  lockHeld = true;

  serverA = spawnServer(PORT_A, { GIF_SHUTDOWN_TIMEOUT_SECONDS: '20' });
  await waitForHealth(PORT_A);

  const reqA = postSessionStart(PORT_A, personaId);
  await waitFor(() => auditInsertIsBlocked(appPool),
    { label: 'audit INSERT blocked on chain lock (A)' });
  pass('audit INSERT reached the chain-lock wait');

  // Simulate LB disconnect: the client vanishes, the handler keeps running.
  reqA.destroy();
  await sleep(200);

  serverA.child.kill('SIGTERM');
  await sleep(1500);

  if (serverA.child.exitCode === null) {
    pass('server still draining 1.5s after SIGTERM (did not exit under in-flight audit write)');
  } else {
    fail('server still draining 1.5s after SIGTERM',
      `exited early with code ${serverA.child.exitCode} — pre-fix behavior (audit write killed mid-flight)`);
  }

  await releaseChainLock(adminClient);
  lockHeld = false;

  const exitA = await Promise.race([serverA.exited, sleep(15000).then(() => null)]);
  if (exitA && exitA.code === 0) {
    pass('server exited 0 after the audit write landed');
  } else {
    fail('server exited 0 after the audit write landed',
      exitA ? `exit code ${exitA.code}, signal ${exitA.signal}` : 'did not exit within 15s of lock release');
  }

  if (serverA.out.stdout.includes('draining before shutdown')) {
    pass('drain start logged');
  } else {
    fail('drain start logged', `stdout: ${serverA.out.stdout.slice(-500)}`);
  }

  const afterCount = (await appPool.query(
    `SELECT count(*)::int AS n FROM gif.audit_events
      WHERE persona_id = $1 AND event_type = 'session_start'`,
    [personaId]
  )).rows[0].n;
  if (afterCount === beforeCount + 1) {
    pass('orphaned session_start audit row present (the row pre-fix shutdown dropped)');
  } else {
    fail('orphaned session_start audit row present',
      `expected ${beforeCount + 1} session_start rows for persona, found ${afterCount}`);
  }

  // -------------------------------------------------------------------------
  // B. Drain is bounded — force-exit nonzero past GIF_SHUTDOWN_TIMEOUT_SECONDS
  // -------------------------------------------------------------------------
  console.log('B. Bounded drain — force-exit past the timeout');

  await acquireChainLock(adminClient);
  lockHeld = true;

  serverB = spawnServer(PORT_B, { GIF_SHUTDOWN_TIMEOUT_SECONDS: '2' });
  await waitForHealth(PORT_B);

  const reqB = postSessionStart(PORT_B, personaId);
  await waitFor(() => auditInsertIsBlocked(appPool),
    { label: 'audit INSERT blocked on chain lock (B)' });
  reqB.destroy();
  await sleep(200);

  serverB.child.kill('SIGTERM');
  const exitB = await Promise.race([serverB.exited, sleep(6000).then(() => null)]);

  if (exitB && exitB.code === 1) {
    pass('force-exit with code 1 within the bound');
  } else {
    fail('force-exit with code 1 within the bound',
      exitB ? `exit code ${exitB.code}, signal ${exitB.signal}` : 'did not exit within 6s (timeout not enforced)');
  }

  if (serverB.out.stderr.includes('forcing exit')) {
    pass('force-exit logged loudly');
  } else {
    fail('force-exit logged loudly', `stderr: ${serverB.out.stderr.slice(-500)}`);
  }

  await releaseChainLock(adminClient);
  lockHeld = false;

  // -------------------------------------------------------------------------
  // C. Clean idle shutdown on SIGINT
  // -------------------------------------------------------------------------
  console.log('C. Clean idle shutdown on SIGINT');

  serverC = spawnServer(PORT_C);
  await waitForHealth(PORT_C);

  serverC.child.kill('SIGINT');
  const exitC = await Promise.race([serverC.exited, sleep(4000).then(() => null)]);

  if (exitC && exitC.code === 0) {
    pass('idle server exits 0 promptly on SIGINT');
  } else {
    fail('idle server exits 0 promptly on SIGINT',
      exitC ? `exit code ${exitC.code}, signal ${exitC.signal}` : 'did not exit within 4s');
  }

  if (serverC.out.stdout.includes('Shutdown complete')) {
    pass('clean shutdown logged');
  } else {
    fail('clean shutdown logged', `stdout: ${serverC.out.stdout.slice(-500)}`);
  }

  // -------------------------------------------------------------------------
  // D. Oversized GIF_SHUTDOWN_TIMEOUT_SECONDS rejected at startup
  // -------------------------------------------------------------------------
  console.log('D. Oversized GIF_SHUTDOWN_TIMEOUT_SECONDS rejected at startup');

  // 9999999999s * 1000 overflows setTimeout's 2^31-1 ms clamp — must fail fast.
  serverD = spawnServer(PORT_A, { GIF_SHUTDOWN_TIMEOUT_SECONDS: '9999999999' });
  const exitD = await Promise.race([serverD.exited, sleep(5000).then(() => null)]);

  if (exitD && exitD.code !== 0 && exitD.code !== null) {
    pass('boot fails nonzero on oversized value');
  } else {
    fail('boot fails nonzero on oversized value',
      exitD ? `exit code ${exitD.code}, signal ${exitD.signal}` : 'still running 5s after spawn — value accepted');
  }

  if (serverD.out.stderr.includes('GIF_SHUTDOWN_TIMEOUT_SECONDS')) {
    pass('boot failure names the misconfigured variable');
  } else {
    fail('boot failure names the misconfigured variable', `stderr: ${serverD.out.stderr.slice(-500)}`);
  }

  // -------------------------------------------------------------------------
  // E. Second signal during drain force-exits immediately
  // -------------------------------------------------------------------------
  console.log('E. Second signal during drain force-exits immediately');

  await acquireChainLock(adminClient);
  lockHeld = true;

  serverE = spawnServer(PORT_E, { GIF_SHUTDOWN_TIMEOUT_SECONDS: '20' });
  await waitForHealth(PORT_E);

  const reqE = postSessionStart(PORT_E, personaId);
  await waitFor(() => auditInsertIsBlocked(appPool),
    { label: 'audit INSERT blocked on chain lock (E)' });
  reqE.destroy();
  await sleep(200);

  serverE.child.kill('SIGTERM');
  await sleep(500);
  if (serverE.child.exitCode === null) {
    pass('first SIGTERM enters drain (still alive)');
  } else {
    fail('first SIGTERM enters drain (still alive)', `exited with code ${serverE.child.exitCode}`);
  }

  serverE.child.kill('SIGTERM');
  const exitE = await Promise.race([serverE.exited, sleep(3000).then(() => null)]);

  if (exitE && exitE.code === 1) {
    pass('second SIGTERM force-exits with code 1');
  } else {
    fail('second SIGTERM force-exits with code 1',
      exitE ? `exit code ${exitE.code}, signal ${exitE.signal}` : 'did not exit within 3s of second signal');
  }

  if (serverE.out.stderr.includes('forcing immediate exit')) {
    pass('second-signal force-exit logged loudly');
  } else {
    fail('second-signal force-exit logged loudly', `stderr: ${serverE.out.stderr.slice(-500)}`);
  }

  await releaseChainLock(adminClient);
  lockHeld = false;
} catch (err) {
  fail('unexpected test error', err.stack || String(err));
} finally {
  if (lockHeld) {
    try { await releaseChainLock(adminClient); } catch { /* best-effort */ }
  }
  for (const s of [serverA, serverB, serverC, serverD, serverE]) {
    if (s && s.child.exitCode === null) s.child.kill('SIGKILL');
  }
  try { await adminClient.end(); } catch { /* best-effort */ }
  await appPool.end();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
