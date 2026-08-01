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

// test_verify_core.mjs
// =============================================================================
// Known-answer tests against the SHIPPED verifier core (dist/audit/verify-core.js).
//
// test_chain_verifier.mjs pins an independent REPLICA of the canonicalizer to
// the vendor-neutral known-answer digests; until the pure core was extracted
// out of the CLI (whose top-level argv/pool/process.exit made it unimportable),
// the shipped code itself was executed by no test — if it drifted and the
// replica did not, the suite stayed green. This file closes that gap: it
// imports the compiled module adopters actually run and asserts the same
// sealed digests. Replica and shipped code passing side by side is the proof
// that the extraction moved no bytes.
//
// Pure core only — no database required. Run from gif/mcp-server/ after a
// build: node test_verify_core.mjs
// =============================================================================

import crypto from 'crypto';

import {
  MAX_FIELD_LEN,
  buildBody,
  buildBodyV2,
  canonicalize,
  normalizeString,
  recomputeHash,
  verifyChain,
} from './dist/audit/verify-core.js';

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

console.log('\nVerify Core (shipped dist/) — Known-Answer Tests\n');

// ---------------------------------------------------------------------------
// Test 1: gif-audit/1 KAT — the same record and digest test_chain_verifier.mjs
// asserts against its replica (its Test 1(0)), here asserted against the
// shipped canonicalizer. The digest is the vendor-neutral known-answer value,
// reproducible by sha256sum of the canonical preimage.
// ---------------------------------------------------------------------------

const KAT_DIGEST = '4ccf79a1a616c55b19cbcb5418d4c5fc31f45f793549a1b07d268b43455e6f10';

{
  const katRow = {
    event_id:              '11111111-1111-1111-1111-111111111111',
    occurred_at:           '2026-06-02T12:00:00.000Z',
    persona_id:            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    session_id:            '55555555-5555-5555-5555-555555555555',
    invoked_by_persona_id: null,
    event_type:            'tool_call',
    tool_name:             'db_read',
    outcome:               'success',
    flagged:               false,
    purpose_declared:      'diligence read',
    canon_version:         'gif-audit/1',
    previous_hash:         null,
  };

  const canonical = canonicalize(buildBody(katRow, katRow.previous_hash));
  const digest = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');

  if (digest === KAT_DIGEST) {
    pass('(1) shipped /1 canonicalizer reproduces the known-answer digest');
  } else {
    fail('(1) shipped /1 canonicalizer reproduces the known-answer digest',
         `expected ${KAT_DIGEST}\n    got      ${digest}\n    canonical=${canonical}`);
  }

  if (recomputeHash(katRow) === KAT_DIGEST) {
    pass('(1) shipped recomputeHash reproduces the known-answer digest');
  } else {
    fail('(1) shipped recomputeHash reproduces the known-answer digest',
         `got ${recomputeHash(katRow)}`);
  }

  // Forward-safety: an unrecognized canon_version is uncheckable, not tamper.
  const futureRow = { ...katRow, canon_version: 'gif-audit/99' };
  if (recomputeHash(futureRow) === null) {
    pass('(1) shipped forward-safety: unknown canon_version → recomputeHash returns null');
  } else {
    fail('(1) shipped forward-safety: unknown canon_version → recomputeHash returns null',
         `got ${recomputeHash(futureRow)}`);
  }
}

// ---------------------------------------------------------------------------
// Test 2: gif-audit/2 KAT — the one-entry caller-governance record gif emits,
// same fixture and digest as test_chain_verifier.mjs Test 1(0b).
// ---------------------------------------------------------------------------

const KAT_CG2_DIGEST = 'd494769c1ae442ea88dd190068747abf63c0568a3b856f85791b1a50a99d48b4';

{
  const emittedRow = {
    event_id:              '99999999-9999-9999-9999-999999999999',
    occurred_at:           '2026-06-06T12:00:00.000Z',
    persona_id:            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    session_id:            '55555555-5555-5555-5555-555555555555',
    invoked_by_persona_id: null,
    event_type:            'tool_call',
    tool_name:             'export',
    outcome:               'deferred',
    flagged:               false,
    purpose_declared:      'reconcile June invoices',
    canon_version:         'gif-audit/2',
    previous_hash:         null,
  };

  const emittedDigest = recomputeHash(emittedRow);
  if (emittedDigest === KAT_CG2_DIGEST) {
    pass('(2) shipped /2 builder reproduces the caller-governance known-answer digest');
  } else {
    fail('(2) shipped /2 builder reproduces the caller-governance known-answer digest',
         `expected ${KAT_CG2_DIGEST}\n    got      ${emittedDigest}`);
  }

  // buildBodyV2 direct path must agree with the recomputeHash routing.
  const direct = crypto.createHash('sha256')
    .update(canonicalize(buildBodyV2(emittedRow, emittedRow.previous_hash)), 'utf8')
    .digest('hex');
  if (direct === KAT_CG2_DIGEST) {
    pass('(2) shipped buildBodyV2 + canonicalize agree with recomputeHash');
  } else {
    fail('(2) shipped buildBodyV2 + canonicalize agree with recomputeHash', `got ${direct}`);
  }
}

// ---------------------------------------------------------------------------
// Test 3: normalizeString contract sanity on the shipped code — control
// characters rejected, U+0020-only trim, length cap present.
// ---------------------------------------------------------------------------

{
  let threw = false;
  try {
    normalizeString('two\nlines');
  } catch {
    threw = true;
  }
  if (threw) {
    pass('(3) shipped normalizeString rejects a C0 control character');
  } else {
    fail('(3) shipped normalizeString rejects a C0 control character', 'no throw');
  }

  const nbsp = normalizeString('\u00a0padded\u00a0');
  if (nbsp === '\u00a0padded\u00a0') {
    pass('(3) shipped normalizeString trims U+0020 only (NBSP preserved)');
  } else {
    fail('(3) shipped normalizeString trims U+0020 only (NBSP preserved)', `got ${JSON.stringify(nbsp)}`);
  }

  if (MAX_FIELD_LEN === 8192) {
    pass('(3) shipped MAX_FIELD_LEN is 8192');
  } else {
    fail('(3) shipped MAX_FIELD_LEN is 8192', `got ${MAX_FIELD_LEN}`);
  }
}

// ---------------------------------------------------------------------------
// Test 4: verifyChain smoke over a clean synthetic 3-row /1 chain — proves the
// moved verifyPartition/verifyChain are importable and function end to end.
// ---------------------------------------------------------------------------

{
  function makeSyntheticRow(overrides, prevEventHash) {
    const base = {
      event_id:              crypto.randomUUID(),
      occurred_at:           '2026-06-03T10:00:00.000Z',
      persona_id:            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      session_id:            '55555555-5555-5555-5555-555555555555',
      event_type:            'tool_call',
      tool_name:             'test_tool',
      outcome:               'success',
      flagged:               false,
      purpose_declared:      'synthetic test',
      invoked_by_persona_id: null,
      canon_version:         'gif-audit/1',
      ...overrides,
    };
    const row = { ...base, previous_hash: prevEventHash ?? null };
    row.event_hash = recomputeHash(row);
    return row;
  }

  const row1 = makeSyntheticRow({ event_id: 'aaaaaaaa-0000-0000-0000-000000000001' }, null);
  const row2 = makeSyntheticRow({ event_id: 'aaaaaaaa-0000-0000-0000-000000000002' }, row1.event_hash);
  const row3 = makeSyntheticRow({ event_id: 'aaaaaaaa-0000-0000-0000-000000000003' }, row2.event_hash);

  const result = verifyChain(new Map([['2026-06-01T00:00:00.000Z', [row1, row2, row3]]]), null);

  if (result.ok === true &&
      result.total_mismatches === 0 &&
      result.total_breaks === 0 &&
      result.partitions[0].hashed_checked === 3 &&
      result.partitions[0].links_verified === 3) {
    pass('(4) shipped verifyChain verifies a clean synthetic 3-row chain');
  } else {
    fail('(4) shipped verifyChain verifies a clean synthetic 3-row chain',
         JSON.stringify(result));
  }
}

// ---------------------------------------------------------------------------
// Test 5: uncheckable/unrecomputable split, DB-free — a poisoned row in a
// RECOGNIZED canonical form fails verification; a row under an unknown
// (future) canon_version stays informational. Pins the shipped split logic
// without a database; the DB-backed end-to-end lives in
// test_verify_integrity_e2e.mjs.
// ---------------------------------------------------------------------------

{
  const cleanRow = {
    event_id:              'bbbbbbbb-0000-0000-0000-000000000001',
    occurred_at:           '2026-06-07T09:00:00.000Z',
    persona_id:            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    session_id:            '55555555-5555-5555-5555-555555555555',
    event_type:            'tool_call',
    tool_name:             'db_read',
    outcome:               'allowed',
    flagged:               false,
    purpose_declared:      'ordinary purpose',
    invoked_by_persona_id: null,
    canon_version:         'gif-audit/2',
    previous_hash:         null,
  };
  const monthKey = '2026-06-01T00:00:00.000Z';

  // Poisoned: control character in purpose_declared, recognized /2 format.
  // The stored hash value is irrelevant — recomputation throws before any
  // comparison — but it must be 64-hex so the row counts as a real hashed row.
  const poisoned = {
    ...cleanRow,
    event_id:         'bbbbbbbb-0000-0000-0000-00000000000e',
    purpose_declared: 'diligence read\nsecond line',
    event_hash:       'e'.repeat(64),
  };
  const pr = verifyChain(new Map([[monthKey, [poisoned]]]), null);
  if (pr.ok === false &&
      pr.total_unrecomputable === 1 &&
      pr.total_uncheckable === 0 &&
      pr.partitions[0].unrecomputable[0] === poisoned.event_id) {
    pass('(5) poisoned /2 row → unrecomputable, chain NOT ok (shipped split logic)');
  } else {
    fail('(5) poisoned /2 row → unrecomputable, chain NOT ok',
         JSON.stringify({ ok: pr.ok, unrec: pr.total_unrecomputable, unch: pr.total_uncheckable }));
  }

  // Forward-safety: unknown canon_version → informational, chain stays ok.
  const future = {
    ...cleanRow,
    event_id:      'bbbbbbbb-0000-0000-0000-00000000000f',
    canon_version: 'gif-audit/99',
    event_hash:    'f'.repeat(64),
  };
  const fr = verifyChain(new Map([[monthKey, [future]]]), null);
  if (fr.ok === true &&
      fr.total_uncheckable === 1 &&
      fr.total_unrecomputable === 0) {
    pass('(5) unknown canon_version row → uncheckable-informational, chain ok (forward-safety)');
  } else {
    fail('(5) unknown canon_version row → uncheckable-informational, chain ok',
         JSON.stringify({ ok: fr.ok, unch: fr.total_uncheckable, unrec: fr.total_unrecomputable }));
  }
}

// ---------------------------------------------------------------------------
// Final summary
// ---------------------------------------------------------------------------

console.log('');
console.log(`${passed + failed} tests — ${passed} passed, ${failed} failed`);
console.log('');

if (failed > 0) process.exit(1);
