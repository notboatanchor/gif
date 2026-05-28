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

// conformance/c5_combination_scoping.mjs
// =============================================================================
// GIF-022 Category 5 — Combination policy scoping conformance.
//
// Category 5 differs from C1–C4 and C6 in one structural way: the MUSTs apply
// to the `checkCombinationPolicies` enforcement primitive (exported from
// gif-enforcement), not to a governed MCP tool. The primitive is adopter-
// invoked per ADR-022; no governed gif MCP tool calls it, so C5.1–C5.3 are
// not observable through the three MCP surfaces used for the other
// categories (tools/list, tool dispatch, db_read on audit_events).
//
// Per GIF-022 (2026-05-27 §C5 scope clarification amendment), C5.x is
// verified at the primitive level by test_combination_policies.mjs, which
// drives createEnforcement(pool).checkCombinationPolicies() directly with
// the eight cases enumerated in that file's header. Case 5 in particular
// witnesses the session-scoped accumulation behavior asserted by C5.1
// (single-session scope) and C5.2 (no cross-session bleed). C5.3 (no
// accumulation for calls lacking a valid gif_session_id) is satisfied
// transitively by C2.2–C2.6 — invalid-handle calls are rejected at
// dispatch before reaching the combination-policy evaluation point.
//
// On extraction to gif-spec, C5.x maps to SEP-2484 documented exclusions
// (not-protocol-observable flavor): the conformance suite entry points at
// the primitive test as the verification artifact, rather than asserting
// through MCP surfaces that do not exist for this category.
//
// This file's job in the conformance suite is therefore narrow:
//   1. Document the verification-surface delegation inline (above), so a
//      reader scanning conformance/ sees C5 accounted for.
//   2. Assert that test_combination_policies.mjs exists on disk, so a
//      future deletion is caught at conformance-suite level.
//   3. Assert that test_combination_policies.mjs is wired into the npm
//      test runner, so a future un-wiring is also caught.
//
// Run from gif/mcp-server/:
//   node conformance/c5_combination_scoping.mjs
// =============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mcpServerDir = resolve(__dirname, '..');
const primitiveTestPath = resolve(mcpServerDir, 'test_combination_policies.mjs');
const packageJsonPath = resolve(mcpServerDir, 'package.json');

// ---------------------------------------------------------------------------
// Pass/fail bookkeeping (matches the c1–c6 sibling files)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function pass(label) { console.log(`  [PASS] ${label}`); passed++; }
function fail(label, detail) {
  console.error(`  [FAIL] ${label}${detail ? ': ' + detail : ''}`);
  failed++;
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

console.log('GIF-022 Category 5 — Combination policy scoping');
console.log('  C5.1: accumulation MUST scope to a single gif_session_id');
console.log('  C5.2: accumulation MUST NOT bleed across distinct sessions');
console.log('  C5.3: accumulation MUST NOT occur for invalid-handle calls');
console.log('  Verification surface: primitive level —');
console.log('    mcp-server/test_combination_policies.mjs');
console.log('  See GIF-022 §Category 5 for the scope clarification.');
console.log('');

// Assertion 1: primitive test file exists.
if (existsSync(primitiveTestPath)) {
  pass('test_combination_policies.mjs exists on disk');
} else {
  fail(
    'test_combination_policies.mjs missing',
    `expected at ${primitiveTestPath}`,
  );
}

// Assertion 2: primitive test is wired into the npm test script.
// We read package.json directly rather than importing — the "test" script
// is a chained command string, not a structured field.
try {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const testScript = pkg.scripts?.test ?? '';
  if (testScript.includes('test_combination_policies.mjs')) {
    pass('test_combination_policies.mjs is wired into npm test');
  } else {
    fail(
      'test_combination_policies.mjs is not in package.json scripts.test',
      'C5 primitive coverage would not run in CI',
    );
  }
} catch (err) {
  fail('could not read package.json', err.message);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('');
console.log(`C5 conformance stub: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
