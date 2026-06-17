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

// test_issue38_legacy_canon.mjs
// =============================================================================
// Regression test for issue #38.
//
// Migration 014 added `canon_version TEXT NOT NULL DEFAULT 'gif-audit/1'`. For
// an adopter who recorded audit rows under v0.1 (hashed by the migration-006
// pipe-delimited preimage) *before* applying 014, the NOT NULL DEFAULT
// retroactively stamps those historical rows 'gif-audit/1' - a RECOGNIZED canon
// they were never hashed under. The chain verifier then recomputes them under
// the /1 sorted-JSON rule, the digest differs from the stored pipe-form hash,
// and the rows land in `mismatches` (tamper) instead of `uncheckable`.
//
// Migration 016 repairs this by re-stamping ONLY the rows it can cryptographically
// prove were hashed under migration 006 to the legacy marker 'gif-audit/0', which
// the verifier does not recognize and therefore classifies as uncheckable.
//
// This test runs entirely as gif_admin inside ONE transaction that is always
// ROLLED BACK. It disables the BEFORE INSERT hash-chain trigger to craft the
// historical rows that the live (gif-audit/2) trigger can no longer produce,
// applies migration 016's body (minus its own BEGIN/COMMIT), and asserts the
// reclassification. Nothing is committed; the audit table is untouched on disk.
// =============================================================================

import pg from 'pg';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const { Client } = pg;

let passed = 0;
let failed = 0;
function pass(msg) { passed++; console.log(`  ✓ ${msg}`); }
function fail(msg, detail) { failed++; console.log(`  ✗ ${msg}${detail ? `\n    ${detail}` : ''}`); }

// ---------------------------------------------------------------------------
// Pure verifier core - ported from src/cli/verify_audit_chain.ts. The .ts/.js
// cannot be imported here (its CLI entrypoint opens a Pool and calls
// process.exit on import). The canonicalizer is pinned to the vendor-neutral
// known-answer test in test_chain_verifier.mjs; this is a faithful copy. The
// control-character guard uses charCodeAt (ASCII-only source); it rejects C0
// control characters (U+0000 through U+001F) plus U+007F, matching the source.
// ---------------------------------------------------------------------------
const MAX_FIELD_LEN = 8192;

function normalizeString(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) {
      throw new Error('control character in protected string field');
    }
  }
  const n = s.normalize('NFC').replace(/^ +| +$/g, '');
  if (n.length > MAX_FIELD_LEN) {
    throw new Error('protected string field exceeds length cap');
  }
  return n;
}

function canonicalize(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('non-finite number');
    return JSON.stringify(v);
  }
  if (typeof v === 'string') return JSON.stringify(normalizeString(v));
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  if (typeof v === 'object') {
    const o = v;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(o[k])).join(',') + '}';
  }
  throw new Error('uncanonicalizable value');
}

function buildBody(row, previousHash) {
  return {
    event_id:      row.event_id,
    event_type:    row.event_type,
    occurred_at:   row.occurred_at,
    outcome:       row.outcome,
    previous_hash: previousHash,
    principal_id:  row.persona_id,
    profile:       'caller-governance',
    profile_data: {
      flagged:                 row.flagged,
      invoked_by_principal_id: row.invoked_by_persona_id,
      purpose_declared:        row.purpose_declared,
      session_id:              row.session_id,
    },
    tool_name:     row.tool_name,
  };
}

function buildBodyV2(row, previousHash) {
  return {
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
    previous_hash: previousHash,
    principal_id:  row.persona_id,
    tool_name:     row.tool_name ?? null,
  };
}

function recomputeHash(row) {
  let preimage;
  if (row.canon_version === 'gif-audit/2') {
    preimage = canonicalize(buildBodyV2(row, row.previous_hash));
  } else if (row.canon_version === 'gif-audit/1') {
    preimage = canonicalize(buildBody(row, row.previous_hash));
  } else {
    return null;
  }
  return crypto.createHash('sha256').update(preimage, 'utf8').digest('hex');
}

// Mirrors verifyPartition's per-row decision so we can classify a single row
// without standing up a partition map.
function classify(row) {
  if (row.event_hash === null) return 'legacy_null';
  if (row.event_hash === 'HASH_ERROR') return 'hash_error';
  let expected;
  try { expected = recomputeHash(row); } catch { expected = null; }
  if (expected === null) return 'uncheckable';
  return expected === row.event_hash ? 'verified' : 'mismatch';
}

// Same projection the verifier CLI's DB shell uses (occurred_at via the trigger's
// to_char ms-RFC3339 expression; flagged as a real boolean).
const PROJECTION = `
  event_id::text,
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
  previous_hash`;

// The migration-006 pipe-delimited preimage, recomputed in SQL from a row's
// stored columns - byte-identical to what the migration-006 trigger produced.
// Used to fabricate a faithful "legacy 006 row" event_hash.
const SQL_006_HASH = `encode(sha256(convert_to(
  concat_ws('|',
    event_id::text,
    occurred_at::text,
    persona_id::text,
    COALESCE(session_id::text, 'NULL'),
    event_type,
    COALESCE(tool_name, 'NULL'),
    outcome,
    flagged::text,
    COALESCE(previous_hash, 'NULL')
  ), 'UTF8')), 'hex')`;

console.log('\nIssue #38 - legacy canon reclassification (migration 016)\n');

const client = new Client({
  host:     process.env.PGHOST     || 'localhost',
  port:     parseInt(process.env.PGPORT || '5432'),
  user:     process.env.PGADMINUSER || 'gif_admin',
  password: process.env.PGADMINPASSWORD,
  database: process.env.PGDATABASE || 'gif',
});

try {
  await client.connect();
} catch (err) {
  console.log(`  ⚠ DB unreachable (${err.message}) - skipping issue-38 integration test.`);
  console.log('');
  process.exit(0);
}

try {
  await client.query('BEGIN');
  // Pin UTC so the bare occurred_at::text cast the migration-006 preimage uses
  // renders identically at craft time and at migration-016 recompute time.
  await client.query(`SET LOCAL timezone = 'UTC'`);
  await client.query('ALTER TABLE gif.audit_events DISABLE TRIGGER audit_events_hash_chain');

  const personaRes = await client.query(
    `SELECT persona_id FROM gif.personas WHERE status = 'active' LIMIT 1`,
  );
  if (personaRes.rows.length === 0) {
    throw new Error('no active persona found - run test_setup.mjs first');
  }
  const personaId = personaRes.rows[0].persona_id;

  // Craft a row with the trigger disabled, stamped 'gif-audit/1' (as migration
  // 014's NOT NULL DEFAULT would stamp a pre-existing row).
  async function craftRow(tool) {
    const res = await client.query(
      `INSERT INTO gif.audit_events
         (persona_id, event_type, tool_name, outcome, flagged,
          purpose_declared, canon_version, event_hash, previous_hash)
       VALUES ($1, 'tool_call', $2, 'allowed', false,
          'issue38_regression', 'gif-audit/1', NULL, NULL)
       RETURNING event_id::text`,
      [personaId, tool],
    );
    return res.rows[0].event_id;
  }
  const fetchRow = async (id) =>
    (await client.query(`SELECT ${PROJECTION} FROM gif.audit_events WHERE event_id = $1`, [id])).rows[0];

  // Row A - untampered migration-006 row, mis-stamped gif-audit/1 by 014.
  const idA = await craftRow('issue38_legacy_006');
  await client.query(
    `UPDATE gif.audit_events SET event_hash = ${SQL_006_HASH} WHERE event_id = $1`, [idA]);

  // Row C - tampered: fabricate a correct 006 hash, then mutate a protected
  // field WITHOUT recomputing, so the stored hash matches neither 006 nor /1.
  const idC = await craftRow('issue38_tampered');
  await client.query(
    `UPDATE gif.audit_events SET event_hash = ${SQL_006_HASH} WHERE event_id = $1`, [idC]);
  await client.query(
    `UPDATE gif.audit_events SET outcome = 'denied' WHERE event_id = $1`, [idC]);

  // Row B - genuine gif-audit/1 row (the kind written between migrations 014 and
  // 015). Compute its /1 sorted-JSON hash the way the verifier will and store it.
  const idB = await craftRow('issue38_genuine_v1');
  const bRowForHash = await fetchRow(idB);
  const bHash = recomputeHash({ ...bRowForHash, canon_version: 'gif-audit/1' });
  await client.query(
    `UPDATE gif.audit_events SET event_hash = $2 WHERE event_id = $1`, [idB, bHash]);

  // -------------------------------------------------------------------------
  // PRE-016: reproduce the bug.
  // -------------------------------------------------------------------------
  let A = await fetchRow(idA);
  let B = await fetchRow(idB);
  let C = await fetchRow(idC);

  if (A.canon_version === 'gif-audit/1') {
    pass('pre-016: legacy-006 row carries the migration-014 mis-stamp gif-audit/1');
  } else {
    fail('pre-016: legacy-006 row stamped gif-audit/1', `got ${A.canon_version}`);
  }
  if (classify(A) === 'mismatch') {
    pass('pre-016: verifier MIS-reports the untampered 006 row as tamper (the bug)');
  } else {
    fail('pre-016: untampered 006 row classified as mismatch', `got ${classify(A)}`);
  }
  if (classify(B) === 'verified') {
    pass('pre-016: genuine gif-audit/1 row verifies');
  } else {
    fail('pre-016: genuine /1 row verifies', `got ${classify(B)}`);
  }
  if (classify(C) === 'mismatch') {
    pass('pre-016: tampered row is a mismatch');
  } else {
    fail('pre-016: tampered row is a mismatch', `got ${classify(C)}`);
  }

  // -------------------------------------------------------------------------
  // Apply migration 016's body inside this transaction (strip its own
  // BEGIN;/COMMIT; so the rollback isolation holds).
  // -------------------------------------------------------------------------
  const here = dirname(fileURLToPath(import.meta.url));
  const sqlPath = join(here, '..', 'schema', '016_audit_canon_legacy_repair.sql');
  const raw = readFileSync(sqlPath, 'utf8');
  const body = raw
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return t !== 'BEGIN;' && t !== 'COMMIT;';
    })
    .join('\n');
  await client.query(body);

  // -------------------------------------------------------------------------
  // POST-016: the fix.
  // -------------------------------------------------------------------------
  A = await fetchRow(idA);
  B = await fetchRow(idB);
  C = await fetchRow(idC);

  if (A.canon_version === 'gif-audit/0') {
    pass('post-016: untampered 006 row re-stamped gif-audit/1 -> gif-audit/0');
  } else {
    fail('post-016: 006 row re-stamped gif-audit/0', `got ${A.canon_version}`);
  }
  if (classify(A) === 'uncheckable') {
    pass('post-016: 006 row now classified uncheckable, not tamper (issue #38 fixed)');
  } else {
    fail('post-016: 006 row classified uncheckable', `got ${classify(A)}`);
  }
  if (B.canon_version === 'gif-audit/1' && classify(B) === 'verified') {
    pass('post-016: genuine gif-audit/1 row left intact and still verifies');
  } else {
    fail('post-016: genuine /1 row untouched + verifies',
      `canon=${B.canon_version} class=${classify(B)}`);
  }
  if (C.canon_version === 'gif-audit/1' && classify(C) === 'mismatch') {
    pass('post-016: tampered row NOT masked - still flagged as a mismatch');
  } else {
    fail('post-016: tampered row still flagged',
      `canon=${C.canon_version} class=${classify(C)}`);
  }

  // Idempotency: a second application is a no-op.
  await client.query(body);
  const A2 = await fetchRow(idA);
  const C2 = await fetchRow(idC);
  if (A2.canon_version === 'gif-audit/0' && C2.canon_version === 'gif-audit/1') {
    pass('post-016: migration is idempotent (re-run changes nothing)');
  } else {
    fail('post-016: migration idempotent', `A=${A2.canon_version} C=${C2.canon_version}`);
  }
} catch (err) {
  fail('issue-38 integration test threw', err.message);
} finally {
  await client.query('ROLLBACK').catch(() => {});
  await client.end().catch(() => {});
}

console.log('');
console.log(`${passed + failed} tests - ${passed} passed, ${failed} failed`);
console.log('');

if (failed > 0) process.exit(1);
