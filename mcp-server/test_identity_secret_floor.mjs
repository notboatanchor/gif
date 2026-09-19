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

// test_identity_secret_floor.mjs
// =============================================================================
// IDENTITY_HMAC_SECRET security floor.
//
// .env.example ships IDENTITY_HMAC_SECRET=changeme-use-openssl-rand-hex-32 —
// a publicly known value that is (not coincidentally) exactly 32 characters,
// so a bare minimum-length check does not catch it. An operator who copies
// .env.example unchanged runs a server whose identity-token signing key is
// public: anyone can forge a valid identity_token for persona_create.
//
// No database required — this file exercises the pure helper
// (src/identity-secret.ts) directly, calls createEnforcement() with a mock
// pool to prove the floor rejects a forged token before any query is made,
// and spawns `node dist/index.js` to prove the server refuses to start on a
// secret that fails the floor.
//
// Cases covered:
//   (i)   identitySecretProblem() unit cases — placeholder (exact case,
//         mixed case, and wrapped in a leading space or unstripped quotes), 31/32-byte ASCII, 64-char hex, multi-byte UTF-8
//         measured in bytes not code units.
//   (ii)  verify-time — a token correctly HMAC-signed WITH a floor-failing
//         secret (placeholder, and separately a too-short secret) is
//         rejected by createEnforcement(mockPool).verifyIdentityBinding()
//         with the floor reason, and the mock pool's query() is never
//         called — proving the reject happens before the DB round-trip that
//         _verifyIdentityBinding's Step 3/4 would otherwise make.
//   (iii) startup — `node dist/index.js` with a floor-failing
//         IDENTITY_HMAC_SECRET exits non-zero with the actionable message on
//         stderr. The positive case (a strong secret boots cleanly) is NOT
//         covered here — that requires a live Postgres for the rest of
//         startup/health to succeed, which this file deliberately avoids;
//         it is exercised implicitly by every other suite file that spawns
//         or hits a real server with a real secret (e.g. test_shutdown_drain.mjs).
//
// Run from gif/mcp-server/:
//   npm run build && node test_identity_secret_floor.mjs
// =============================================================================

import { createHmac } from 'crypto';
import { spawn } from 'child_process';
import { identitySecretProblem, IDENTITY_HMAC_SECRET_MIN_BYTES } from './dist/identity-secret.js';
import { createEnforcement } from './dist/enforcement.js';

let passed = 0;
let failed = 0;

function pass(label) { console.log(`  [PASS] ${label}`); passed++; }
function fail(label, detail) {
  console.error(`  [FAIL] ${label}${detail ? ': ' + detail : ''}`);
  failed++;
}

console.log('\n[identity-secret-floor] IDENTITY_HMAC_SECRET security floor\n');

// ---------------------------------------------------------------------------
// (i) identitySecretProblem() unit cases
// ---------------------------------------------------------------------------

console.log('(i) identitySecretProblem() unit cases');

if (IDENTITY_HMAC_SECRET_MIN_BYTES === 32) {
  pass('IDENTITY_HMAC_SECRET_MIN_BYTES is 32');
} else {
  fail('IDENTITY_HMAC_SECRET_MIN_BYTES is 32', `got ${String(IDENTITY_HMAC_SECRET_MIN_BYTES)}`);
}

// The exact .env.example placeholder — 32 characters, so length alone would
// pass it. Must be rejected by the placeholder rule specifically.
const PLACEHOLDER = 'changeme-use-openssl-rand-hex-32';
if (Buffer.byteLength(PLACEHOLDER, 'utf8') !== 32) {
  fail('sanity: .env.example placeholder is 32 bytes',
    `got ${String(Buffer.byteLength(PLACEHOLDER, 'utf8'))} — test fixture assumption broken`);
} else {
  pass('sanity: .env.example placeholder is exactly 32 bytes (length check alone would not catch it)');
}

if (typeof identitySecretProblem(PLACEHOLDER) === 'string') {
  pass('exact .env.example placeholder is rejected');
} else {
  fail('exact .env.example placeholder is rejected', 'identitySecretProblem() returned null');
}

// Case-insensitive: different casing of the same placeholder family.
const MIXED_CASE_PLACEHOLDER = 'CHANGEME-please-replace-this-secret-value';
if (typeof identitySecretProblem(MIXED_CASE_PLACEHOLDER) === 'string') {
  pass('mixed-case "CHANGEME..." placeholder is rejected (case-insensitive)');
} else {
  fail('mixed-case "CHANGEME..." placeholder is rejected', 'identitySecretProblem() returned null');
}

// The placeholder wrapped the way a careless env file can deliver it: a leading
// space, or quotes the loader did not strip. Each is longer than 32 bytes, so
// only the placeholder rule can catch it — a prefix-only match would not.
for (const [label, wrapped] of [
  ['placeholder with a leading space is rejected', ' ' + PLACEHOLDER],
  ['placeholder kept inside double quotes is rejected', '"' + PLACEHOLDER + '"'],
  ["placeholder kept inside single quotes is rejected", "'" + PLACEHOLDER + "'"],
]) {
  if (typeof identitySecretProblem(wrapped) === 'string') {
    pass(label);
  } else {
    fail(label, 'identitySecretProblem() returned null');
  }
}

// 31-byte ASCII secret — one byte under the floor.
const SHORT_31 = 'a'.repeat(31);
if (typeof identitySecretProblem(SHORT_31) === 'string') {
  pass('31-byte ASCII secret is rejected');
} else {
  fail('31-byte ASCII secret is rejected', 'identitySecretProblem() returned null');
}

// 32-byte ASCII secret — exactly at the floor, not a placeholder.
const OK_32 = 'a'.repeat(32);
if (identitySecretProblem(OK_32) === null) {
  pass('32-byte ASCII secret is accepted');
} else {
  fail('32-byte ASCII secret is accepted', identitySecretProblem(OK_32));
}

// 64-char hex secret — what `openssl rand -hex 32` actually produces.
const HEX_64 = '3f'.repeat(32);
if (identitySecretProblem(HEX_64) === null) {
  pass('64-char hex secret is accepted');
} else {
  fail('64-char hex secret is accepted', identitySecretProblem(HEX_64));
}

// Multi-byte UTF-8 measured in bytes, not code units. The Euro sign (U+20AC)
// is 1 UTF-16 code unit (String.prototype.length counts it as 1) but 3 UTF-8
// bytes. 11 of them: .length === 11 (would fail a naive `.length < 32`
// check) but Buffer.byteLength(...) === 33 (>= the 32-byte floor). Built via
// String.fromCharCode — no literal escape sequences in source.
const EURO = String.fromCharCode(0x20ac);
const MULTIBYTE_11 = EURO.repeat(11);
if (MULTIBYTE_11.length >= IDENTITY_HMAC_SECRET_MIN_BYTES) {
  fail('sanity: multi-byte fixture has fewer code units than the byte floor',
    `got .length ${String(MULTIBYTE_11.length)} — test fixture assumption broken`);
} else if (Buffer.byteLength(MULTIBYTE_11, 'utf8') < IDENTITY_HMAC_SECRET_MIN_BYTES) {
  fail('sanity: multi-byte fixture has at least the byte floor in UTF-8 bytes',
    `got ${String(Buffer.byteLength(MULTIBYTE_11, 'utf8'))} bytes — test fixture assumption broken`);
} else {
  pass('sanity: multi-byte fixture is short in code units, long enough in bytes');
}
if (identitySecretProblem(MULTIBYTE_11) === null) {
  pass('multi-byte UTF-8 secret accepted on byte length, not code-unit length');
} else {
  fail('multi-byte UTF-8 secret accepted on byte length, not code-unit length',
    identitySecretProblem(MULTIBYTE_11));
}

// The problem string itself must never contain the rejected secret value.
const secretProblemText = identitySecretProblem(PLACEHOLDER) ?? '';
if (!secretProblemText.includes(PLACEHOLDER)) {
  pass('problem string for the placeholder does not contain the secret value verbatim');
} else {
  fail('problem string for the placeholder does not contain the secret value verbatim', secretProblemText);
}

// ---------------------------------------------------------------------------
// (ii) verify-time — createEnforcement(mockPool).verifyIdentityBinding()
// ---------------------------------------------------------------------------

console.log('\n(ii) verify-time rejection (mock pool, no DB)');

function signToken(secret, assignmentId, issuedAt) {
  const payload = Buffer.from(JSON.stringify({
    assignment_id: assignmentId,
    issued_at:     issuedAt ?? new Date().toISOString(),
  })).toString('base64url');
  const hmac = createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${hmac}`;
}

function makeMockPool() {
  const calls = [];
  return {
    calls,
    query: async (...args) => {
      calls.push(args);
      // Should never be reached in the cases below — if it is, return
      // something that would otherwise look like a valid lookup, so a bug
      // that skips the floor check doesn't also fail on an unrelated shape
      // mismatch and mask the real assertion (queryCalled).
      return { rows: [], rowCount: 0 };
    },
  };
}

async function assertRejectedBeforeQuery(label, secretEnvValue, assignmentId) {
  const previous = process.env.IDENTITY_HMAC_SECRET;
  process.env.IDENTITY_HMAC_SECRET = secretEnvValue;
  try {
    // Token is correctly signed WITH the floor-failing secret — a real
    // forgery a holder of that (public/short) secret could produce.
    const identityToken = signToken(secretEnvValue, assignmentId);
    const mockPool = makeMockPool();
    const enforcement = createEnforcement(mockPool);
    const result = await enforcement.verifyIdentityBinding({ identityToken });

    if (result.valid !== false) {
      fail(label, `expected valid: false, got ${JSON.stringify(result)}`);
      return;
    }
    if (!result.reason.includes('IDENTITY_HMAC_SECRET') || !result.reason.includes('minimum-strength')) {
      fail(label, `reason is not the floor reason: ${result.reason}`);
      return;
    }
    // The caller-visible reason must not disclose the secret's length — that
    // detail belongs in the server log only.
    if (/[0-9]/.test(result.reason)) {
      fail(label, `caller-visible reason contains a digit (length leak?): ${result.reason}`);
      return;
    }
    if (mockPool.calls.length !== 0) {
      fail(label, `pool.query() was called ${String(mockPool.calls.length)} time(s) — floor check did not short-circuit before the DB round-trip`);
      return;
    }
    pass(label);
  } finally {
    process.env.IDENTITY_HMAC_SECRET = previous;
  }
}

await assertRejectedBeforeQuery(
  'forged token signed with the .env.example placeholder is rejected, pool.query() never called',
  PLACEHOLDER,
  '22222222-2222-2222-2222-222222222222',
);

await assertRejectedBeforeQuery(
  'forged token signed with a 31-byte secret is rejected, pool.query() never called',
  SHORT_31,
  '33333333-3333-3333-3333-333333333333',
);

// ---------------------------------------------------------------------------
// (iii) startup — `node dist/index.js` refuses to boot
// ---------------------------------------------------------------------------

console.log('\n(iii) startup fail-fast (spawned process, no DB)');

// Resolves on child exit or after timeoutMs, whichever is first. The timer is
// cleared on exit so a passing run does not idle for the rest of the timeout.
function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ code: null, signal: null, timedOut: true }), timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut: false });
    });
  });
}

async function assertStartupRefused(label, secretEnvValue, port) {
  const child = spawn(process.execPath, ['dist/index.js'], {
    env: { ...process.env, IDENTITY_HMAC_SECRET: secretEnvValue, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.resume(); // drain — nothing on stdout is asserted

  const outcome = await waitForExit(child, 5000);
  if (outcome.timedOut) {
    fail(label, 'server did not exit within 5s — startup check did not fire');
    child.kill('SIGKILL');
    return;
  }
  if (outcome.code === 0 || outcome.code === null) {
    fail(label, `expected non-zero exit, got code ${String(outcome.code)}, signal ${String(outcome.signal)}`);
    return;
  }
  if (!stderr.includes('IDENTITY_HMAC_SECRET')) {
    fail(label, `stderr does not name IDENTITY_HMAC_SECRET: ${stderr.slice(-500)}`);
    return;
  }
  if (!stderr.includes('openssl rand -hex 32')) {
    fail(label, `stderr does not give the actionable generate command: ${stderr.slice(-500)}`);
    return;
  }
  pass(label);
}

const BASE_PORT = parseInt(process.env.TEST_IDENTITY_FLOOR_PORT || '3450', 10);

await assertStartupRefused(
  'server exits non-zero on the .env.example placeholder secret',
  PLACEHOLDER,
  BASE_PORT,
);

await assertStartupRefused(
  'server exits non-zero on a 31-byte secret',
  SHORT_31,
  BASE_PORT + 1,
);

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
