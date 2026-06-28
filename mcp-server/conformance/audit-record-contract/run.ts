// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Notboatanchor Labs LLC
//
// Tamper-Evident Audit Record Contract — conformance vector runner. Zero external dependencies.
//   npx tsx run.ts
//   # or Node >= 22.6:
//   node --experimental-strip-types run.ts

import { VECTORS, type Vector } from './vectors.ts';

let passed = 0;
let failed = 0;

function evaluateVector(v: Vector): { ok: boolean; note: string } {
  const result = v.evaluate();
  // A vector "passes the suite" when the verifier's verdict matches expectation:
  //  - expect 'conformant'    -> the verifier accepts (result.ok === true)
  //  - expect 'nonconformant' -> the verifier rejects (result.ok === false)
  const suiteOk =
    v.expect === 'conformant' ? result.ok : !result.ok;
  const note =
    v.expect === 'nonconformant' && !result.ok
      ? `correctly rejected (${result.failures[0] ?? 'detected'})`
      : result.failures.join('; ') || 'ok';
  return { ok: suiteOk, note };
}

console.log('\nTamper-Evident Audit Record Contract — conformance vectors\n');

let lastReq = '';
for (const v of VECTORS) {
  if (v.requirement !== lastReq) {
    console.log(`  [${v.requirement}]`);
    lastReq = v.requirement;
  }
  const { ok, note } = evaluateVector(v);
  if (ok) {
    console.log(`    ✓ ${v.id} — ${v.title}`);
    passed++;
  } else {
    console.error(`    ✗ ${v.id} — ${v.title}\n        ${note}`);
    failed++;
  }
}

console.log(`\n${passed + failed} vectors — ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.error('VECTOR SET FAILED');
  process.exit(1);
} else {
  console.log('Vector set passed');
}
