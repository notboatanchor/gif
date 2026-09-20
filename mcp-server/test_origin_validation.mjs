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

// test_origin_validation.mjs
// =============================================================================
// Origin header validation (DNS-rebinding protection) — MCP 2026-07-28
// Streamable HTTP, Security Warning: "Servers MUST validate the `Origin`
// header on all incoming connections to prevent DNS rebinding attacks. If
// the `Origin` header is present and invalid, servers MUST respond with HTTP
// 403 Forbidden."
//
// gif validates Origin — not Host; see the comment above http.createServer in
// src/index.ts for why Host validation is out of scope for the hosted server
// — in front of the /mcp delegation, using GIF_ALLOWED_ORIGINS
// (src/origin-allowlist.ts, parsed at startup) and the SDK's
// validateOriginHeader() (called per-request).
//
// Uses node:http requests directly (not fetch) throughout, so the Origin and
// Host headers can be set to values fetch would otherwise normalize, or
// refuse to send at all (e.g. the literal `null` origin, or a Host that
// disagrees with the actual TCP destination).
//
// Cases covered:
//   (i)   parseAllowedOrigins() unit cases — default (undefined/empty/
//         whitespace-only), a configured hostname list (trimmed, lowercased,
//         and the SDK's localhost default NOT included), and every rejected
//         shape (scheme, port, path, wildcard, empty/trailing-comma entries,
//         internal whitespace, bare and over-specified IPv6, and
//         non-canonical names — stray dots, labels edged with a hyphen),
//         plus names that must be accepted verbatim (underscore, punycode,
//         the `origin.invalid` sentinel).
//   (ii)  integration — against the running server at MCP_BASE_URL (default
//         http://localhost:3100, same convention as the rest of the suite):
//         a disallowed Origin gets 403 with the generic caller-visible
//         message (the offending origin is never echoed back), the opaque
//         `null` Origin is rejected, the classic DNS-rebinding Host+Origin
//         shape is rejected, the SDK's localhost defaults pass, a missing
//         Origin header passes (non-browser MCP clients send none), and
//         /health is deliberately NOT Origin-validated.
//   (iii) startup — GIF_ALLOWED_ORIGINS set to a value parseAllowedOrigins()
//         rejects refuses to boot (same fail-fast contract proven for
//         IDENTITY_HMAC_SECRET in test_identity_secret_floor.mjs); a
//         configured hostname list REPLACES the SDK's localhost default,
//         proven by spawning a real server and showing the configured origin
//         passes while a localhost origin (which would pass on the default)
//         now gets 403. No database is required for either startup case —
//         Origin validation happens before the SDK's MCP handler is reached.
//
// Run from gif/mcp-server/:
//   npm run build && node test_origin_validation.mjs
// =============================================================================

import http from 'node:http';
import { spawn } from 'node:child_process';
import { parseAllowedOrigins } from './dist/origin-allowlist.js';

let passed = 0;
let failed = 0;

function pass(label) { console.log(`  [PASS] ${label}`); passed++; }
function fail(label, detail) {
  console.error(`  [FAIL] ${label}${detail ? ': ' + detail : ''}`);
  failed++;
}

console.log('\n[origin-validation] Origin header allowlist (DNS-rebinding protection)\n');

// ---------------------------------------------------------------------------
// (i) parseAllowedOrigins() unit cases
// ---------------------------------------------------------------------------

console.log('(i) parseAllowedOrigins() unit cases');

const LOCALHOST_DEFAULT = ['localhost', '127.0.0.1', '[::1]'];

function assertDefault(label, raw) {
  const result = parseAllowedOrigins(raw);
  if (result.ok && JSON.stringify(result.hostnames) === JSON.stringify(LOCALHOST_DEFAULT)) {
    pass(label);
  } else {
    fail(label, JSON.stringify(result));
  }
}

assertDefault('undefined -> the three localhost defaults', undefined);
assertDefault("'' (empty string) -> the three localhost defaults", '');
assertDefault("'   ' (whitespace-only) -> the three localhost defaults", '   ');

{
  const label = "'app.example.com, Admin.Example.COM' -> trimmed, lowercased, localhost NOT included";
  const result = parseAllowedOrigins('app.example.com, Admin.Example.COM');
  if (
    result.ok &&
    JSON.stringify(result.hostnames) === JSON.stringify(['app.example.com', 'admin.example.com']) &&
    !result.hostnames.includes('localhost')
  ) {
    pass(label);
  } else {
    fail(label, JSON.stringify(result));
  }
}

{
  const label = "'[::1]' -> accepted as a single bracketed IPv6 entry";
  const result = parseAllowedOrigins('[::1]');
  if (result.ok && JSON.stringify(result.hostnames) === JSON.stringify(['[::1]'])) {
    pass(label);
  } else {
    fail(label, JSON.stringify(result));
  }
}

for (const bad of [
  'https://app.example.com',
  'app.example.com:8443',
  'app.example.com/path',
  '*.example.com',
  'a,,b',
  'a,',
  'exa mple.com',
  '::1',
  '[::1]:3000',
  // Non-canonical names the URL parser accepts verbatim — refused so a
  // copy-paste slip cannot leave a silently dead allowlist entry.
  'localhost.',
  '.localhost',
  'app..example.com',
  '-app.example.com',
  'app-.example.com',
]) {
  const label = `${JSON.stringify(bad)} is rejected`;
  const result = parseAllowedOrigins(bad);
  if (result.ok === false && typeof result.problem === 'string' && result.problem.length > 0) {
    pass(label);
  } else {
    fail(label, JSON.stringify(result));
  }
}

for (const good of [
  'my_app.internal',          // underscore tolerated (internal names use them)
  'xn--bcher-kva.example',    // punycode form of an internationalized name
  'origin.invalid',           // the documented "reject every browser origin" sentinel
]) {
  const label = `${JSON.stringify(good)} is accepted verbatim`;
  const result = parseAllowedOrigins(good);
  if (result.ok && JSON.stringify(result.hostnames) === JSON.stringify([good])) {
    pass(label);
  } else {
    fail(label, JSON.stringify(result));
  }
}

// ---------------------------------------------------------------------------
// Shared raw-HTTP request helper (node:http, not fetch — see banner comment)
// ---------------------------------------------------------------------------

// Sends one request and resolves { status, body }. `hostHeader` overrides the
// Host header sent on the wire without changing the actual TCP destination
// (host/port below) — the DNS-rebinding shape: an attacker's DNS answer can
// point evil.example at this machine, but the socket still connects to
// localhost. 5s request timeout so a hung connection fails the case instead
// of hanging the suite.
function rawRequest({ host = 'localhost', port, path = '/mcp', method = 'POST', origin, hostHeader, body }) {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const headers = {};
    if (hostHeader !== undefined) headers['Host'] = hostHeader;
    if (origin !== undefined) headers['Origin'] = origin;
    if (bodyStr !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Accept'] = 'application/json, text/event-stream';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = http.request({ host, port, path, method, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.setTimeout(5000, () => { req.destroy(new Error('request timed out after 5s')); });
    req.on('error', reject);
    if (bodyStr !== undefined) req.write(bodyStr);
    req.end();
  });
}

const TOOLS_LIST_BODY = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

// ---------------------------------------------------------------------------
// (ii) integration — against the running server (MCP_BASE_URL)
// ---------------------------------------------------------------------------

console.log('\n(ii) integration — running server (MCP_BASE_URL)');

const MCP_URL = process.env.MCP_BASE_URL || 'http://localhost:3100';
const mcpUrlParsed = new URL(MCP_URL);
const MCP_HOST = mcpUrlParsed.hostname;
const MCP_PORT = mcpUrlParsed.port || (mcpUrlParsed.protocol === 'https:' ? '443' : '80');

async function assertRejected(label, opts) {
  try {
    const res = await rawRequest({ host: MCP_HOST, port: MCP_PORT, path: '/mcp', method: 'POST', body: TOOLS_LIST_BODY, ...opts });
    if (res.status !== 403) {
      fail(label, `expected 403, got ${res.status} — body: ${res.body.slice(0, 300)}`);
      return;
    }
    let parsedBody;
    try { parsedBody = JSON.parse(res.body); } catch { parsedBody = null; }
    if (!parsedBody || parsedBody.jsonrpc !== '2.0' || !parsedBody.error || parsedBody.error.code !== -32000) {
      fail(label, `expected a JSON-RPC 2.0 error with code -32000, got: ${res.body.slice(0, 300)}`);
      return;
    }
    if (parsedBody.id !== null) {
      fail(label, `expected id: null, got ${JSON.stringify(parsedBody.id)}`);
      return;
    }
    if (res.body.includes('evil.example')) {
      fail(label, 'response body echoes the offending origin back to the caller');
      return;
    }
    pass(label);
  } catch (err) {
    fail(label, err.message);
  }
}

async function assertNotRejected(label, opts) {
  try {
    const res = await rawRequest({ host: MCP_HOST, port: MCP_PORT, path: '/mcp', method: 'POST', body: TOOLS_LIST_BODY, ...opts });
    if (res.status === 403) {
      fail(label, `got 403 — body: ${res.body.slice(0, 300)}`);
      return;
    }
    pass(label);
  } catch (err) {
    fail(label, err.message);
  }
}

await assertRejected('Origin: http://evil.example -> 403, generic body, no echo of the origin', {
  origin: 'http://evil.example',
});

await assertRejected("Origin: 'null' (opaque origin) -> 403", {
  origin: 'null',
});

await assertRejected('DNS-rebinding shape (Host + Origin both evil.example) -> 403', {
  origin:     `http://evil.example:${MCP_PORT}`,
  hostHeader: `evil.example:${MCP_PORT}`,
});

{
  // The check sits in front of the /mcp delegation regardless of method, so a
  // bad Origin is refused before the SDK gets to answer GET with its own 405.
  const label = 'GET /mcp with Origin: http://evil.example -> 403 (validated before method handling)';
  try {
    const res = await rawRequest({ host: MCP_HOST, port: MCP_PORT, path: '/mcp', method: 'GET', origin: 'http://evil.example' });
    if (res.status === 403) {
      pass(label);
    } else {
      fail(label, `expected 403, got ${res.status} — body: ${res.body.slice(0, 300)}`);
    }
  } catch (err) {
    fail(label, err.message);
  }
}

await assertNotRejected('Origin: http://localhost:6274 -> NOT 403 (SDK localhost default)', {
  origin: 'http://localhost:6274',
});

await assertNotRejected('Origin: http://127.0.0.1:9 -> NOT 403 (SDK localhost default)', {
  origin: 'http://127.0.0.1:9',
});

await assertNotRejected('no Origin header -> NOT 403 (non-browser MCP clients send none)', {});

{
  const label = 'GET /health with Origin: http://evil.example -> 200 (deliberately not Origin-validated)';
  try {
    const res = await rawRequest({ host: MCP_HOST, port: MCP_PORT, path: '/health', method: 'GET', origin: 'http://evil.example' });
    if (res.status === 200) {
      pass(label);
    } else {
      fail(label, `expected 200, got ${res.status} — body: ${res.body.slice(0, 300)}`);
    }
  } catch (err) {
    fail(label, err.message);
  }
}

// ---------------------------------------------------------------------------
// (iii) startup — spawned `node dist/index.js`
// ---------------------------------------------------------------------------

console.log('\n(iii) startup (spawned process, no DB required — the Origin gate sits in front of it)');

// A strong, non-placeholder secret so IDENTITY_HMAC_SECRET's own floor never
// fires in these cases — the fail-fast under test here is GIF_ALLOWED_ORIGINS'.
// 64 hex characters, same construction as test_identity_secret_floor.mjs's HEX_64.
const VALID_SECRET = '3f'.repeat(32);

const BASE_PORT = parseInt(process.env.TEST_ORIGIN_VALIDATION_PORT || '3987', 10);

// Resolves on child exit or after timeoutMs, whichever is first. Mirrors
// test_identity_secret_floor.mjs's waitForExit.
function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ code: null, signal: null, timedOut: true }), timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut: false });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await rawRequest({ port, path: '/health', method: 'GET' });
      if (res.status === 200) return true;
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  return false;
}

// (a) A GIF_ALLOWED_ORIGINS value parseAllowedOrigins() rejects refuses to boot.
{
  const label = 'GIF_ALLOWED_ORIGINS=https://app.example.com (a scheme) -> non-zero exit, stderr names GIF_ALLOWED_ORIGINS';
  const port = BASE_PORT;
  const child = spawn(process.execPath, ['dist/index.js'], {
    env: {
      ...process.env,
      IDENTITY_HMAC_SECRET:  VALID_SECRET,
      GIF_ALLOWED_ORIGINS:   'https://app.example.com',
      PORT:                  String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.resume();

  try {
    const outcome = await waitForExit(child, 5000);
    if (outcome.timedOut) {
      fail(label, 'server did not exit within 5s — startup check did not fire');
    } else if (outcome.code === 0 || outcome.code === null) {
      fail(label, `expected non-zero exit, got code ${String(outcome.code)}, signal ${String(outcome.signal)}`);
    } else if (!stderr.includes('GIF_ALLOWED_ORIGINS') || !stderr.includes('includes a scheme')) {
      // Both substrings: the variable name alone would also match an unrelated
      // startup failure that merely mentions it.
      fail(label, `stderr does not name GIF_ALLOWED_ORIGINS with the scheme problem: ${stderr.slice(-500)}`);
    } else {
      pass(label);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

// (b) A configured hostname list REPLACES the SDK's localhost default.
{
  const port = BASE_PORT + 1;
  const child = spawn(process.execPath, ['dist/index.js'], {
    env: {
      ...process.env,
      IDENTITY_HMAC_SECRET:  VALID_SECRET,
      GIF_ALLOWED_ORIGINS:   'app.example.com',
      PORT:                  String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.resume();

  try {
    const up = await waitForHealth(port, 10000);
    if (!up) {
      fail('server starts with GIF_ALLOWED_ORIGINS=app.example.com', `did not become healthy within 10s — stderr: ${stderr.slice(-500)}`);
    } else {
      pass('server starts with GIF_ALLOWED_ORIGINS=app.example.com');

      // No database configured — the assertion is deliberately loose here
      // (see banner comment): the Origin gate runs before any DB access, so
      // it is enough that the allowed origin does not get 403.
      try {
        const allowed = await rawRequest({ port, path: '/mcp', method: 'POST', body: TOOLS_LIST_BODY, origin: 'https://app.example.com' });
        if (allowed.status === 403) {
          fail('configured origin (https://app.example.com) -> NOT 403', `got 403 — body: ${allowed.body.slice(0, 300)}`);
        } else {
          pass('configured origin (https://app.example.com) -> NOT 403');
        }
      } catch (err) {
        fail('configured origin (https://app.example.com) -> NOT 403', err.message);
      }

      try {
        const rejected = await rawRequest({ port, path: '/mcp', method: 'POST', body: TOOLS_LIST_BODY, origin: 'http://localhost:6274' });
        if (rejected.status === 403) {
          pass('localhost origin -> 403 now that the configured list replaced the default');
        } else {
          fail('localhost origin -> 403 now that the configured list replaced the default', `got ${rejected.status}`);
        }
      } catch (err) {
        fail('localhost origin -> 403 now that the configured list replaced the default', err.message);
      }
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
