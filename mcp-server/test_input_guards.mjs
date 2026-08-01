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

// test_input_guards.mjs
// =============================================================================
// Regression guard: inputSchema constraints are enforced at runtime.
//
// The low-level MCP Server performs no JSON-Schema validation of tool
// inputSchemas, so every declared constraint needs a runtime guard:
//
//   Part 1 — the arg-guards helpers (findMissingRequiredArg,
//            nonEmptyStringArgError, jsonObjectArgError).
//   Part 2 — dispatcher coverage: for EVERY tool in the registry, each
//            required field is either flagged by findMissingRequiredArg when
//            absent, or is one of the two fields the dispatcher checks
//            dedicatedly (persona_id, gif_session_id). A future tool with a
//            new required field is covered automatically.
//   Part 3 — handler value guards: present-but-invalid values (empty strings
//            bypassing minLength, JSON 'null'/arrays/scalars where an object
//            is required, out-of-bounds limit) reject as clean tool errors
//            BEFORE any query runs — so this part needs no database.
//
// Imports the COMPILED modules from ./dist — run `npm run build` first. (CI's
// integration job builds before the test suite.)
// =============================================================================

let argGuards, registry, dbRead, dbWrite, personaCreate, personaRevoke;
try {
  argGuards     = await import('./dist/tools/arg-guards.js');
  registry      = await import('./dist/tools/registry.js');
  dbRead        = await import('./dist/tools/db_read.js');
  dbWrite       = await import('./dist/tools/db_write.js');
  personaCreate = await import('./dist/tools/persona_create.js');
  personaRevoke = await import('./dist/tools/persona_revoke.js');
} catch (err) {
  console.error('Could not import compiled modules from ./dist — run `npm run build` first.');
  console.error(`    ${err.message}`);
  process.exit(1);
}

const { findMissingRequiredArg, nonEmptyStringArgError, jsonObjectArgError } = argGuards;
const { TOOL_REGISTRY } = registry;
const { executeDbRead } = dbRead;
const { executeDbWrite } = dbWrite;
const { executePersonaCreate } = personaCreate;
const { executePersonaRevoke } = personaRevoke;

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

function errorText(result) {
  try {
    return JSON.parse(result.content[0].text).error ?? '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Part 1 — the arg-guards helpers
// ---------------------------------------------------------------------------

console.log('\nInput Guards — Part 1: arg-guards helpers\n');

// findMissingRequiredArg
{
  const required = ['persona_id', 'gif_session_id', 'table', 'record'];

  if (findMissingRequiredArg(required, { table: 't', record: 'r' }) === null) {
    pass('findMissingRequiredArg: null when all non-dispatcher fields present');
  } else {
    fail('findMissingRequiredArg: null when all non-dispatcher fields present');
  }

  if (findMissingRequiredArg(required, { record: 'r' }) === 'table') {
    pass('findMissingRequiredArg: flags absent field');
  } else {
    fail('findMissingRequiredArg: flags absent field');
  }

  if (findMissingRequiredArg(required, { table: null, record: 'r' }) === 'table') {
    pass('findMissingRequiredArg: null value counts as missing');
  } else {
    fail('findMissingRequiredArg: null value counts as missing');
  }

  // Empty string is PRESENT for the dispatcher check — value validation is
  // the handler's job (audited rejection).
  if (findMissingRequiredArg(required, { table: '', record: 'r' }) === null) {
    pass('findMissingRequiredArg: empty string is present (handler-level concern)');
  } else {
    fail('findMissingRequiredArg: empty string is present (handler-level concern)');
  }

  if (findMissingRequiredArg(['persona_id', 'gif_session_id'], {}) === null) {
    pass('findMissingRequiredArg: skips dispatcher-checked persona_id/gif_session_id');
  } else {
    fail('findMissingRequiredArg: skips dispatcher-checked persona_id/gif_session_id');
  }

  if (findMissingRequiredArg(undefined, {}) === null) {
    pass('findMissingRequiredArg: tolerates undefined required list');
  } else {
    fail('findMissingRequiredArg: tolerates undefined required list');
  }
}

// nonEmptyStringArgError
for (const [value, label] of [
  ['', 'empty string'],
  [' ', 'whitespace-only (single space)'],
  ['\t\n  ', 'whitespace-only (tabs/newlines)'],
  [42, 'number'],
  [null, 'null'],
  [undefined, 'undefined'],
  [{}, 'object'],
  [['x'], 'array'],
]) {
  const msg = nonEmptyStringArgError([['purpose', value]]);
  if (typeof msg === 'string' && msg.includes('purpose')) {
    pass(`nonEmptyStringArgError rejects ${label}`);
  } else {
    fail(`nonEmptyStringArgError rejects ${label}`, `got ${JSON.stringify(msg)}`);
  }
}
if (nonEmptyStringArgError([['purpose', 'real purpose'], ['created_by', 'ops']]) === null) {
  pass('nonEmptyStringArgError accepts non-empty strings');
} else {
  fail('nonEmptyStringArgError accepts non-empty strings');
}

// Control characters (C0 + DEL) embedded in an otherwise non-empty string:
// they survive .trim(), and via persona.purpose they reach purpose_declared
// inside the hashed audit canonical form, where the verifier's
// normalizeString rejects them — the row hashes fine at emit and can never
// be recomputed at verify. Rejected for every guarded field, not just
// purpose.
for (const [value, label] of [
  ['two\nlines', 'embedded newline (pasted multi-line string)'],
  ['tab\there', 'embedded tab'],
  ['nul\u0000byte', 'embedded NUL'],
  ['esc\u001bsequence', 'embedded ESC'],
  ['del\u007fchar', 'embedded DEL'],
]) {
  const msg = nonEmptyStringArgError([['purpose', value]]);
  if (typeof msg === 'string' && msg.includes('control character')) {
    pass(`nonEmptyStringArgError rejects ${label}`);
  } else {
    fail(`nonEmptyStringArgError rejects ${label}`, `got ${JSON.stringify(msg)}`);
  }
}
// Same rule on a non-purpose field — the guard is deliberately broad.
{
  const msg = nonEmptyStringArgError([['reason', 'line one\nline two']]);
  if (typeof msg === 'string' && msg.includes('reason') && msg.includes('control character')) {
    pass('nonEmptyStringArgError rejects control characters in reason (broad rule, all guarded fields)');
  } else {
    fail('nonEmptyStringArgError rejects control characters in reason', `got ${JSON.stringify(msg)}`);
  }
}
// Boundary: U+0020 and printable non-ASCII are NOT control characters.
if (nonEmptyStringArgError([['purpose', 'spaces are fine'], ['created_by', 'café ops']]) === null) {
  pass('nonEmptyStringArgError accepts spaces and printable non-ASCII');
} else {
  fail('nonEmptyStringArgError accepts spaces and printable non-ASCII');
}

// jsonObjectArgError
for (const [value, label] of [
  [null, "JSON 'null'"],
  [[1, 2], 'array'],
  [42, 'number'],
  ['s', 'string'],
  [true, 'boolean'],
]) {
  const msg = jsonObjectArgError(value, 'record');
  if (typeof msg === 'string' && msg.includes('record')) {
    pass(`jsonObjectArgError rejects ${label}`);
  } else {
    fail(`jsonObjectArgError rejects ${label}`, `got ${JSON.stringify(msg)}`);
  }
}
if (jsonObjectArgError({ a: 1 }, 'record') === null && jsonObjectArgError({}, 'record') === null) {
  pass('jsonObjectArgError accepts plain objects (including empty)');
} else {
  fail('jsonObjectArgError accepts plain objects (including empty)');
}

// ---------------------------------------------------------------------------
// Part 2 — dispatcher coverage across the whole registry
//
// Every required field of every registered tool must be caught when absent:
// either by findMissingRequiredArg (what the dispatcher calls) or by being
// one of the two fields the dispatcher checks dedicatedly.
// ---------------------------------------------------------------------------

console.log('\nInput Guards — Part 2: dispatcher coverage of every registered tool\n');

const DISPATCHER_DEDICATED = new Set(['persona_id', 'gif_session_id']);

for (const handler of TOOL_REGISTRY.values()) {
  const { name } = handler.definition;
  const required = handler.definition.inputSchema?.required;

  // Fail LOUD on structural omissions — a tool that ships without a required
  // array (or without persona_id / gif_session_id in it) would otherwise get
  // no dispatcher-level presence enforcement and no signal from this test.
  if (!Array.isArray(required) || !required.includes('persona_id')) {
    fail(`${name} declares inputSchema.required including persona_id`,
      `required=${JSON.stringify(required)}`);
    continue;
  }
  if (!handler.skipSession && !required.includes('gif_session_id')) {
    fail(`${name} (governed) declares gif_session_id in inputSchema.required`,
      `required=${JSON.stringify(required)}`);
    continue;
  }
  pass(`${name} declares required incl. persona_id${handler.skipSession ? '' : ' + gif_session_id'}`);

  for (const field of required) {
    if (DISPATCHER_DEDICATED.has(field)) {
      pass(`${name}.${field} — dedicated dispatcher check`);
      continue;
    }
    // Build args carrying every OTHER required field, omitting this one.
    const args = {};
    for (const f of required) {
      if (f !== field) args[f] = 'x';
    }
    if (findMissingRequiredArg(required, args) === field) {
      pass(`${name}.${field} — absent field flagged by dispatcher required-check`);
    } else {
      fail(`${name}.${field} — absent field flagged by dispatcher required-check`,
        `findMissingRequiredArg returned ${JSON.stringify(findMissingRequiredArg(required, args))}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Part 3 — handler value guards (no DB needed)
//
// Personas carry exactly the scope each handler checks, so execution reaches
// the value guards (not a scope short-circuit). Every rejection returns
// before pool.query.
// ---------------------------------------------------------------------------

console.log('\nInput Guards — Part 3: handler value guards (no DB needed)\n');

const SESSION_ID = '99999999-9999-9999-9999-999999999999';

const readPersona = {
  persona_id: '11111111-1111-1111-1111-111111111111',
  purpose: 'input-guard regression test',
  scope_definition: {
    permitted_actions: ['read'],
    permitted_sources: ['sessions'],
  },
};

const writePersona = {
  persona_id: '22222222-2222-2222-2222-222222222222',
  purpose: 'input-guard regression test',
  scope_definition: {
    permitted_actions: ['write'],
    output_destinations: ['user_persona_assignments'],
  },
};

const managerPersona = {
  persona_id: '33333333-3333-3333-3333-333333333333',
  purpose: 'input-guard regression test',
  scope_definition: {
    permitted_actions: ['manage_personas'],
  },
};

// db_read: declared limit bounds (minimum 1, maximum 1000) are enforced.
for (const [limit, label] of [
  [0, 'limit 0 (below minimum)'],
  [1001, 'limit 1001 (above maximum)'],
  [-5, 'limit -5'],
  [NaN, 'limit NaN'],
  ['100', 'limit as string'],
]) {
  const result = await executeDbRead(
    { persona_id: readPersona.persona_id, table: 'sessions', limit },
    readPersona,
    SESSION_ID,
  );
  if (result.isError === true && /between 1 and 1000/.test(errorText(result))) {
    pass(`db_read rejects ${label}`);
  } else {
    fail(`db_read rejects ${label}`, `isError=${result.isError} error=${JSON.stringify(errorText(result))}`);
  }
}

// db_read: filters that parse to a non-object are rejected, not crashed on.
for (const [filters, label] of [
  ['null', "filters 'null' (JSON null)"],
  ['[1,2]', 'filters array'],
  ['42', 'filters scalar'],
]) {
  const result = await executeDbRead(
    { persona_id: readPersona.persona_id, table: 'sessions', filters, limit: 100 },
    readPersona,
    SESSION_ID,
  );
  if (result.isError === true && /filters must be a JSON object/.test(errorText(result))) {
    pass(`db_read rejects ${label}`);
  } else {
    fail(`db_read rejects ${label}`, `isError=${result.isError} error=${JSON.stringify(errorText(result))}`);
  }
}

// db_write: records that parse to a non-object are rejected, not crashed on.
for (const [record, label] of [
  ['null', "record 'null' (JSON null)"],
  ['[{"a":1}]', 'record array'],
  ['"text"', 'record scalar string'],
  ['42', 'record scalar number'],
]) {
  const result = await executeDbWrite(
    { persona_id: writePersona.persona_id, table: 'user_persona_assignments', record },
    writePersona,
    SESSION_ID,
  );
  if (result.isError === true && /record must be a JSON object/.test(errorText(result))) {
    pass(`db_write rejects ${label}`);
  } else {
    fail(`db_write rejects ${label}`, `isError=${result.isError} error=${JSON.stringify(errorText(result))}`);
  }
}

// persona_create: declared minLength 1 string fields reject empty/non-string
// values — an empty purpose would defeat the purpose-non-nullable guarantee.
const validCreateArgs = {
  persona_id:       managerPersona.persona_id,
  issuing_entity:   'test-entity',
  purpose:          'a real declared purpose',
  created_by:       'test-operator',
  scope_definition: '{"permitted_actions":["read"]}',
  valid_until:      '2027-01-01T00:00:00Z',
  // identity_token intentionally absent — its own guard rejects AFTER the
  // guards under test, so a case that passes them still stops before the DB.
};

for (const field of ['issuing_entity', 'purpose', 'created_by', 'valid_until']) {
  for (const [value, label] of [['', 'empty string'], [' ', 'whitespace-only'], [42, 'non-string']]) {
    const result = await executePersonaCreate(
      { ...validCreateArgs, [field]: value },
      managerPersona,
      SESSION_ID,
    );
    const msg = errorText(result);
    if (result.isError === true && msg === `${field} must be a non-empty string`) {
      pass(`persona_create rejects ${field} = ${label}`);
    } else {
      fail(`persona_create rejects ${field} = ${label}`, `isError=${result.isError} error=${JSON.stringify(msg)}`);
    }
  }
}

// persona_create: scope_definition that parses to a non-object is rejected —
// a JSON null would survive JSONB NOT NULL and mint a persona whose scope
// checks throw on every governed call.
for (const [scope, label] of [
  ['null', "scope_definition 'null' (JSON null)"],
  ['[1]', 'scope_definition array'],
  ['42', 'scope_definition scalar'],
]) {
  const result = await executePersonaCreate(
    { ...validCreateArgs, scope_definition: scope },
    managerPersona,
    SESSION_ID,
  );
  if (result.isError === true && /scope_definition must be a JSON object/.test(errorText(result))) {
    pass(`persona_create rejects ${label}`);
  } else {
    fail(`persona_create rejects ${label}`, `isError=${result.isError} error=${JSON.stringify(errorText(result))}`);
  }
}

// persona_create: declared max_delegation_depth minimum (0) is enforced when
// the caller provides a value; absent falls back to the schema default.
for (const [value, label] of [
  [-1, 'negative'],
  [NaN, 'NaN'],
  ['3', 'string'],
]) {
  const result = await executePersonaCreate(
    { ...validCreateArgs, max_delegation_depth: value },
    managerPersona,
    SESSION_ID,
  );
  if (result.isError === true && /max_delegation_depth/.test(errorText(result))) {
    pass(`persona_create rejects max_delegation_depth = ${label}`);
  } else {
    fail(`persona_create rejects max_delegation_depth = ${label}`,
      `isError=${result.isError} error=${JSON.stringify(errorText(result))}`);
  }
}

// persona_create: the guards under test do not swallow the identity_token
// gate — args that pass them still reject on the absent token, before any DB.
{
  const result = await executePersonaCreate(validCreateArgs, managerPersona, SESSION_ID);
  if (result.isError === true && /identity_token is required/.test(errorText(result))) {
    pass('persona_create with valid strings still stops at the identity_token gate');
  } else {
    fail('persona_create with valid strings still stops at the identity_token gate',
      `isError=${result.isError} error=${JSON.stringify(errorText(result))}`);
  }
}

// persona_revoke: declared minLength 1 string fields reject empty/non-string
// values — a revocation must carry a real reason and actor identity.
const validRevokeArgs = {
  persona_id:        managerPersona.persona_id,
  target_persona_id: '44444444-4444-4444-4444-444444444444',
  reason:            'compromised credentials',
  revoked_by:        'test-operator',
};

for (const field of ['target_persona_id', 'reason', 'revoked_by']) {
  for (const [value, label] of [['', 'empty string'], [' ', 'whitespace-only'], [42, 'non-string']]) {
    const result = await executePersonaRevoke(
      { ...validRevokeArgs, [field]: value },
      managerPersona,
      SESSION_ID,
    );
    const msg = errorText(result);
    if (result.isError === true && msg === `${field} must be a non-empty string`) {
      pass(`persona_revoke rejects ${field} = ${label}`);
    } else {
      fail(`persona_revoke rejects ${field} = ${label}`, `isError=${result.isError} error=${JSON.stringify(msg)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
