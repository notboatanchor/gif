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

// test_normalization_rejection.mjs
// =============================================================================
// The canonical-form string rejection set — control characters (Unicode
// category Cc: C0, DEL, C1) and unpaired surrogate code units — asserted
// against the code that ships:
//
//   (1) the SHIPPED verifier core        dist/audit/verify-core.js
//   (2) the conformance reference verifier
//                                        conformance/audit-record-contract/
//   (3) the input guard                  dist/tools/arg-guards.js
//   (4) end to end through verifyChain:  a rejected value in a recognized
//       canon_version is `unrecomputable` and FAILS verification — never
//       `uncheckable`, never tamper.
//
// The two .mjs replicas run the same shared table (normalization_cases.mjs)
// inside their own files, since their canonicalizers are file-local.
//
// Pure functions only — no database required. The conformance verifier is a
// .ts file, so this script needs Node's type stripping (Node >= 22.6 — the
// same floor `npm run vectors` already has):
//   node --experimental-strip-types test_normalization_rejection.mjs
// (run from gif/mcp-server/ after a build).
// =============================================================================

import {
  normalizeString as shippedNormalizeString,
  recomputeHash,
  verifyChain,
} from './dist/audit/verify-core.js';
import { nonEmptyStringArgError } from './dist/tools/arg-guards.js';
import {
  normalizeString as conformanceNormalizeString,
} from './conformance/audit-record-contract/audit-record-contract.ts';
import {
  CONTROL_REJECTS,
  SURROGATE_REJECTS,
  ACCEPTS,
  runNormalizationCases,
} from './normalization_cases.mjs';

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

console.log('\nCanonical-form string rejection set\n');

// ---------------------------------------------------------------------------
// (1) + (2): the shared table against both importable canonicalizers.
// ---------------------------------------------------------------------------

runNormalizationCases(shippedNormalizeString, 'shipped core', pass, fail);
runNormalizationCases(conformanceNormalizeString, 'conformance verifier', pass, fail);

// ---------------------------------------------------------------------------
// (3): the input guard rejects everything the verifier rejects — no value it
// admits can later trip the verifier — and admits what the verifier admits.
// ---------------------------------------------------------------------------

for (const [label, input] of CONTROL_REJECTS) {
  const msg = nonEmptyStringArgError([['purpose', input]]);
  if (msg === 'purpose must not contain control characters') pass(`[input guard] rejects ${label}`);
  else fail(`[input guard] rejects ${label}`, `got ${JSON.stringify(msg)}`);
}
for (const [label, input] of SURROGATE_REJECTS) {
  const msg = nonEmptyStringArgError([['purpose', input]]);
  if (msg === 'purpose must not contain unpaired surrogates') pass(`[input guard] rejects ${label}`);
  else fail(`[input guard] rejects ${label}`, `got ${JSON.stringify(msg)}`);
}
for (const [label, input] of ACCEPTS) {
  const msg = nonEmptyStringArgError([['purpose', input]]);
  if (msg === null) pass(`[input guard] accepts ${label}`);
  else fail(`[input guard] accepts ${label}`, `got ${JSON.stringify(msg)}`);
}

// ---------------------------------------------------------------------------
// (4): end to end. A clean head row, then a row whose purpose_declared carries
// the rejected value. The poisoned row's event_hash is an arbitrary 64-hex
// value: the trigger would have hashed the raw string, and the verifier must
// refuse to recompute it rather than compare.
// ---------------------------------------------------------------------------

{
  const monthKey = '2026-09-01T00:00:00.000Z';
  const base = {
    occurred_at:           '2026-09-18T10:00:00.000Z',
    persona_id:            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    session_id:            '55555555-5555-5555-5555-555555555555',
    event_type:            'tool_call',
    tool_name:             'test_tool',
    outcome:               'success',
    flagged:               false,
    invoked_by_persona_id: null,
    canon_version:         'gif-audit/2',
  };

  for (const [what, value] of [
    ['C1 control (NEL, U+0085)', 'line one' + String.fromCharCode(0x85) + 'line two'],
    ['unpaired high surrogate', 'purpose ' + String.fromCharCode(0xd800)],
  ]) {
    const head = {
      ...base,
      event_id:         '11111111-1111-1111-1111-111111111111',
      purpose_declared: 'clean head row',
      previous_hash:    null,
    };
    head.event_hash = recomputeHash(head);

    const poisoned = {
      ...base,
      event_id:         '22222222-2222-2222-2222-222222222222',
      purpose_declared: value,
      previous_hash:    head.event_hash,
      event_hash:       'f'.repeat(64),
    };

    const r = verifyChain(new Map([[monthKey, [head, poisoned]]]), null);
    if (r.ok === false &&
        r.total_unrecomputable === 1 &&
        r.total_uncheckable === 0 &&
        r.total_mismatches === 0 &&
        r.total_breaks === 0) {
      pass(`[verifyChain] ${what} in purpose_declared → unrecomputable, verification FAILS, not reported as tamper`);
    } else {
      fail(`[verifyChain] ${what} in purpose_declared → unrecomputable, verification fails`,
        JSON.stringify({
          ok: r.ok, unrec: r.total_unrecomputable, unch: r.total_uncheckable,
          mism: r.total_mismatches, breaks: r.total_breaks,
        }));
    }
  }
}

// ---------------------------------------------------------------------------
// Final summary
// ---------------------------------------------------------------------------

console.log('');
console.log(`${passed + failed} tests — ${passed} passed, ${failed} failed`);
console.log('');

if (failed > 0) process.exit(1);
