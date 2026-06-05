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

// test_sql_injection.mjs
// =============================================================================
// Regression guard: caller-supplied SQL identifiers (filter keys in db_read,
// column names in db_write) must be validated + escaped, never interpolated
// raw. A key like  id" = id OR pg_sleep(10) IS NOT NULL --  must be rejected,
// not executed.
//
// Two layers:
//   Part 1 — the sql-identifier helper (isSafeIdentifier / quoteIdentifier).
//   Part 2 — the real db_read / db_write handlers: a malicious identifier is
//            rejected BEFORE any query runs. The rejection path short-circuits
//            ahead of pool.query, so this part needs no database.
//
// Imports the COMPILED modules from ./dist — run `npm run build` first. (CI's
// integration job builds before the test suite.)
// =============================================================================

let sqlIdent, dbRead, dbWrite;
try {
  sqlIdent = await import('./dist/tools/sql-identifier.js');
  dbRead   = await import('./dist/tools/db_read.js');
  dbWrite  = await import('./dist/tools/db_write.js');
} catch (err) {
  console.error('Could not import compiled modules from ./dist — run `npm run build` first.');
  console.error(`    ${err.message}`);
  process.exit(1);
}

const { isSafeIdentifier, quoteIdentifier } = sqlIdent;
const { executeDbRead } = dbRead;
const { executeDbWrite } = dbWrite;

// ---------------------------------------------------------------------------
// Pass/fail bookkeeping (same shape as the rest of the suite)
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

// A representative battery of identifier-injection vectors.
const INJECTION_VECTORS = [
  'id" = id OR pg_sleep(10) IS NOT NULL --', // the canonical break-out
  'x") VALUES (1); DROP TABLE gif.personas; --',
  'a" OR "1"="1',
  'col; DROP TABLE x',
  'a b',           // whitespace
  'a"b',           // embedded quote
  'a.b',           // qualified name / dot
  'a-b',           // operator char
  '1abc',          // leading digit
  '',              // empty
  'a'.repeat(64),  // exceeds the 63-byte cap
  'na\u0000me',    // NUL byte
  'na\tme',    // tab (control char)
  'аdmin',    // Cyrillic homoglyph - non-ASCII, must be rejected
];

// Legitimate gif-schema-shaped identifiers — must NOT be rejected.
const SAFE_IDENTIFIERS = [
  'persona_id',
  'status',
  'event_type',
  'invoked_by_persona_id',
  '_internal',
  'a1',
  'A_Mixed_Case_Col',
  'x'.repeat(63),  // exactly the cap
];

// ---------------------------------------------------------------------------
// Part 1 — the identifier helper
// ---------------------------------------------------------------------------

console.log('\nSQL Injection — Part 1: identifier helper\n');

for (const v of INJECTION_VECTORS) {
  if (isSafeIdentifier(v) === false) {
    pass(`isSafeIdentifier rejects ${JSON.stringify(v)}`);
  } else {
    fail(`isSafeIdentifier rejects ${JSON.stringify(v)}`, 'returned true');
  }
}

// Non-string inputs are not safe identifiers.
for (const v of [null, undefined, 42, {}, ['x']]) {
  if (isSafeIdentifier(v) === false) {
    pass(`isSafeIdentifier rejects non-string ${String(v)}`);
  } else {
    fail(`isSafeIdentifier rejects non-string ${String(v)}`, 'returned true');
  }
}

for (const v of SAFE_IDENTIFIERS) {
  if (isSafeIdentifier(v) === true) {
    pass(`isSafeIdentifier accepts ${JSON.stringify(v)}`);
  } else {
    fail(`isSafeIdentifier accepts ${JSON.stringify(v)}`, 'returned false');
  }
}

// quoteIdentifier double-quotes a valid identifier ...
if (quoteIdentifier('persona_id') === '"persona_id"') {
  pass('quoteIdentifier("persona_id") wraps in double quotes');
} else {
  fail('quoteIdentifier("persona_id") wraps in double quotes', `got ${quoteIdentifier('persona_id')}`);
}

// ... and throws (fails closed) on every injection vector, never emitting raw text.
for (const v of INJECTION_VECTORS) {
  let threw = false;
  try {
    quoteIdentifier(v);
  } catch {
    threw = true;
  }
  if (threw) {
    pass(`quoteIdentifier throws on ${JSON.stringify(v)}`);
  } else {
    fail(`quoteIdentifier throws on ${JSON.stringify(v)}`, 'did not throw');
  }
}

// ---------------------------------------------------------------------------
// Part 2 — the real handlers reject the vector before any query
//
// Personas carry exactly the scope each handler checks, so execution reaches
// the identifier validation (not a scope/allowlist short-circuit). The
// rejection returns before pool.query, so no database is required.
// ---------------------------------------------------------------------------

console.log('\nSQL Injection — Part 2: handler rejection (no DB needed)\n');

const SESSION_ID = '99999999-9999-9999-9999-999999999999';

const readPersona = {
  persona_id: '11111111-1111-1111-1111-111111111111',
  purpose: 'sql-injection regression test',
  scope_definition: {
    permitted_actions: ['read'],
    permitted_sources: ['sessions'],
  },
};

const writePersona = {
  persona_id: '22222222-2222-2222-2222-222222222222',
  purpose: 'sql-injection regression test',
  scope_definition: {
    permitted_actions: ['write'],
    output_destinations: ['user_persona_assignments'],
  },
};

function errorText(result) {
  try {
    return JSON.parse(result.content[0].text).error ?? '';
  } catch {
    return '';
  }
}

// db_read: a malicious filter KEY is rejected as an invalid identifier.
for (const v of INJECTION_VECTORS.filter((s) => s.length > 0)) {
  const result = await executeDbRead(
    { persona_id: readPersona.persona_id, table: 'sessions', filters: JSON.stringify({ [v]: 'x' }), limit: 100 },
    readPersona,
    SESSION_ID,
  );
  const msg = errorText(result);
  if (result.isError === true && /invalid filter key/i.test(msg)) {
    pass(`db_read rejects filter key ${JSON.stringify(v)}`);
  } else {
    fail(`db_read rejects filter key ${JSON.stringify(v)}`, `isError=${result.isError} error=${JSON.stringify(msg)}`);
  }
}

// db_write: a malicious COLUMN name is rejected as an invalid identifier.
for (const v of INJECTION_VECTORS.filter((s) => s.length > 0)) {
  const result = await executeDbWrite(
    { persona_id: writePersona.persona_id, table: 'user_persona_assignments', record: JSON.stringify({ [v]: 'y' }) },
    writePersona,
    SESSION_ID,
  );
  const msg = errorText(result);
  if (result.isError === true && /invalid column name/i.test(msg)) {
    pass(`db_write rejects column ${JSON.stringify(v)}`);
  } else {
    fail(`db_write rejects column ${JSON.stringify(v)}`, `isError=${result.isError} error=${JSON.stringify(msg)}`);
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
