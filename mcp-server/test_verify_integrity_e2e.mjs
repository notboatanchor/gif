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

// test_verify_integrity_e2e.mjs
// =============================================================================
// End-to-end regression test for the verify-path integrity defect: a
// `purpose_declared` carrying an ordinary control character (an embedded
// newline — a pasted multi-line string) is accepted by the schema, hashed
// without complaint by the migration-015 trigger (which must never throw),
// and then cannot be recomputed by the verifier. The verifier must report
// that chain as NOT verified — before the uncheckable-bucket split it filed
// the rows as informational `uncheckable` and reported the chain green.
//
// The fixture is seeded by DIRECT SQL, not through the persona_create MCP
// tool, deliberately:
//   - the input guard on persona_create (control-character rejection) covers
//     one entry path; rows can arrive by others (adopter-side writes, future
//     tools, migrations). The honest assertion is "if a poisoned row exists
//     in the chain, the verifier reports it," whatever path wrote it.
//   - it keeps this test independent of that guard, which would otherwise
//     reject the fixture and break this test.
//
// This test APPENDS permanently unverifiable rows to the audit chain (audit
// rows are INSERT-only and are never rewritten). The suite's own DB-backed
// tests scope their verification to their own sessions and stay green, but
// a whole-database run of the operator CLI (verify_audit_chain) against a
// persisted dev volume that has run this test will — correctly — exit
// non-zero. Wipe the volume to get a clean chain (the standing procedure);
// CI starts fresh every run. This file runs LAST in npm test.
//
// Run from gif/mcp-server/ with DB creds in env (test-local.sh sets them).
// =============================================================================

import pg from 'pg';

import { verifyChain } from './dist/audit/verify-core.js';

// Destructive-fixture gate: this test permanently appends unverifiable rows
// to whatever database the env points at (INSERT-only — no cleanup exists by
// design). scripts/test-local.sh and CI set the gate against gif's own
// disposable compose stack; a bare `npm test` pointed at the wrong database
// (a documented recurring hazard) skips instead of poisoning it.
if (process.env.GIF_AUDIT_E2E !== '1') {
  console.log('\nVerify-Path Integrity — End-to-End: SKIPPED');
  console.log('  (set GIF_AUDIT_E2E=1 — this test permanently appends unverifiable');
  console.log('   rows to the target audit chain; run it only against a disposable DB)\n');
  process.exit(0);
}

const { Pool } = pg;

const dbConfig = {
  host:     process.env.PGHOST || 'localhost',
  port:     parseInt(process.env.PGPORT || '5432'),
  user:     process.env.PGUSER || 'gif_app',
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
  if (detail !== undefined) console.error(`    ${detail}`);
  failed++;
}

console.log('\nVerify-Path Integrity — End-to-End (poisoned purpose_declared)\n');

const POISONED_PURPOSE = 'diligence read\nsecond line pasted from a document';

const pool = new Pool(dbConfig);

try {
  // -------------------------------------------------------------------------
  // Seed: a persona whose purpose contains an embedded newline, via direct
  // SQL. The schema accepts it — purpose is VARCHAR(1000) NOT NULL with no
  // CHECK constraint (schema/001_gif_core.sql) — which is itself part of the
  // finding chain this test pins.
  // -------------------------------------------------------------------------

  const personaResult = await pool.query(
    `INSERT INTO gif.personas
       (issuing_entity, purpose, created_by, scope_definition, valid_until)
     VALUES
       ('integrity-e2e-test', $1, 'test_verify_integrity_e2e',
        '{"permitted_sources":[],"permitted_actions":["read"]}'::jsonb,
        now() + interval '1 hour')
     RETURNING persona_id, purpose`,
    [POISONED_PURPOSE],
  );
  const personaId = personaResult.rows[0].persona_id;

  if (personaResult.rows[0].purpose === POISONED_PURPOSE) {
    pass('schema accepts a persona purpose containing a control character (no CHECK constraint)');
  } else {
    fail('schema accepts a persona purpose containing a control character',
         JSON.stringify(personaResult.rows[0].purpose));
  }

  const sessionResult = await pool.query(
    `INSERT INTO gif.sessions (persona_id, invocation_context)
     VALUES ($1, $2) RETURNING session_id`,
    [personaId, JSON.stringify({ test: 'verify_integrity_e2e' })],
  );
  const sessionId = sessionResult.rows[0].session_id;

  // Real audit rows carrying the poisoned purpose_declared — the trigger
  // computes real hashes over them (it never throws; migration 015).
  for (const tool of ['e2e_tool_1', 'e2e_tool_2', 'e2e_tool_3']) {
    await pool.query(
      `INSERT INTO gif.audit_events
         (persona_id, session_id, event_type, tool_name, outcome, flagged, purpose_declared)
       VALUES ($1, $2, 'tool_call', $3, 'allowed', false, $4)`,
      [personaId, sessionId, tool, POISONED_PURPOSE],
    );
  }

  // -------------------------------------------------------------------------
  // The emit side succeeded: rows exist, the control character is stored
  // verbatim, and the trigger hashed every row (real 64-hex hashes, not the
  // HASH_ERROR sentinel). This resolves the "does any layer strip or alter
  // the character before/at emission" unknown: none does.
  // -------------------------------------------------------------------------

  const rawRows = await pool.query(
    `SELECT event_id::text,
            to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at,
            to_char(date_trunc('month', occurred_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS month_key,
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
    [sessionId],
  );

  if (rawRows.rows.length === 3) {
    pass('3 audit rows generated for the poisoned persona');
  } else {
    fail('3 audit rows generated for the poisoned persona', `got ${rawRows.rows.length}`);
  }

  if (rawRows.rows.every(r => r.purpose_declared === POISONED_PURPOSE)) {
    pass('purpose_declared stored verbatim — control character intact in every row');
  } else {
    fail('purpose_declared stored verbatim',
         JSON.stringify(rawRows.rows.map(r => r.purpose_declared)));
  }

  if (rawRows.rows.every(r => /^[0-9a-f]{64}$/.test(r.event_hash ?? ''))) {
    pass('trigger hashed every poisoned row (real 64-hex event_hash, no HASH_ERROR)');
  } else {
    fail('trigger hashed every poisoned row',
         JSON.stringify(rawRows.rows.map(r => r.event_hash)));
  }

  if (rawRows.rows.every(r => r.canon_version === 'gif-audit/2')) {
    pass('rows stamped canon_version gif-audit/2 (a format this verifier fully recognizes)');
  } else {
    fail('rows stamped canon_version gif-audit/2',
         JSON.stringify(rawRows.rows.map(r => r.canon_version)));
  }

  // -------------------------------------------------------------------------
  // The verify side: the shipped verifyChain (imported from dist/) over the
  // poisoned rows. The chain MUST NOT be reported verified — these rows are
  // recognized-format rows the verifier cannot recompute (normalization
  // rejection), which is `unrecomputable`, counted against ok. They must NOT
  // be filed under `uncheckable`, which is reserved for unrecognized
  // canon_version rows (forward-safety, informational).
  // -------------------------------------------------------------------------

  const monthKey = rawRows.rows[0].month_key;
  const auditRows = rawRows.rows.map(({ month_key: _unused, ...row }) => row);
  const result = verifyChain(new Map([[monthKey, auditRows]]), null);

  if (result.ok === false) {
    pass('verifyChain reports the poisoned chain as NOT verified (ok === false)');
  } else {
    fail('verifyChain reports the poisoned chain as NOT verified (ok === false)',
         `result.ok === true — the false green: ${JSON.stringify({
           total_mismatches: result.total_mismatches,
           total_breaks: result.total_breaks,
           total_uncheckable: result.total_uncheckable,
           total_unrecomputable: result.total_unrecomputable,
         })}`);
  }

  const p = result.partitions[0];

  if (Array.isArray(p.unrecomputable) && p.unrecomputable.length === 3) {
    pass('all 3 poisoned rows filed as unrecomputable (normalization rejection)');
  } else {
    fail('all 3 poisoned rows filed as unrecomputable (normalization rejection)',
         `unrecomputable=${JSON.stringify(p.unrecomputable)} uncheckable=${JSON.stringify(p.uncheckable)}`);
  }

  if (Array.isArray(p.uncheckable) && p.uncheckable.length === 0) {
    pass('no poisoned row filed as uncheckable — that bucket stays reserved for unknown canon_version');
  } else {
    fail('no poisoned row filed as uncheckable',
         `uncheckable=${JSON.stringify(p.uncheckable)}`);
  }

  if (result.total_unrecomputable === 3) {
    pass('total_unrecomputable === 3');
  } else {
    fail('total_unrecomputable === 3', `got ${result.total_unrecomputable}`);
  }

  // Forward-safety must SURVIVE the split: a row stamped with an unknown
  // canon_version stays informational and does not fail the chain.
  const futureRow = {
    ...auditRows[0],
    event_id:      '00000000-0000-0000-0000-00000000f0f0',
    canon_version: 'gif-audit/99',
  };
  const fsResult = verifyChain(new Map([[monthKey, [futureRow]]]), null);
  if (fsResult.ok === true &&
      fsResult.total_uncheckable === 1 &&
      fsResult.total_unrecomputable === 0) {
    pass('forward-safety preserved: unknown canon_version row is uncheckable-informational, chain still ok');
  } else {
    fail('forward-safety preserved: unknown canon_version row is uncheckable-informational',
         JSON.stringify({
           ok: fsResult.ok,
           total_uncheckable: fsResult.total_uncheckable,
           total_unrecomputable: fsResult.total_unrecomputable,
         }));
  }

  // Session hygiene: close the fixture session. The audit rows remain — they
  // are INSERT-only by design (see the header note about persisted volumes).
  await pool.query(
    `UPDATE gif.sessions SET ended_at = now() WHERE session_id = $1`,
    [sessionId],
  );

} catch (err) {
  fail('end-to-end run', err instanceof Error ? err.stack : String(err));
} finally {
  await pool.end();
}

// ---------------------------------------------------------------------------
// Final summary
// ---------------------------------------------------------------------------

console.log('');
console.log(`${passed + failed} tests — ${passed} passed, ${failed} failed`);
console.log('');

if (failed > 0) process.exit(1);
