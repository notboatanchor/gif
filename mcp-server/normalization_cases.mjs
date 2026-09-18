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

// normalization_cases.mjs
// =============================================================================
// Shared case table for the canonical-form string rejection set. NOT a test
// script — it is imported by the tests that each hold one of the four
// canonicalizer implementations:
//
//   test_normalization_rejection.mjs — shipped core (dist/audit/verify-core.js)
//                                      + the conformance reference verifier
//   test_chain_verifier.mjs          — its independent replica
//   test_hash_chain.mjs              — its replica
//
// One table, four implementations: a site that drifts from the others fails
// here instead of silently. Expectations are derived from the numeric
// definition of the rejected set (code-point ranges), never from a regex, so
// the table cannot share a bug with the implementations it checks.
//
// Every character is built with String.fromCharCode — no escape sequences and
// no invisible characters in this source file.
// =============================================================================

const ch = (cp) => String.fromCharCode(cp);

// Unicode general category Cc: C0 (U+0000-U+001F), DEL (U+007F), C1 (U+0080-U+009F).
export const isControl = (cp) => cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f);
export const isSurrogateUnit = (cp) => cp >= 0xd800 && cp <= 0xdfff;

const HI = ch(0xd800);      // first high surrogate
const HI_LAST = ch(0xdbff); // last high surrogate
const LO = ch(0xdc00);      // first low surrogate
const LO_LAST = ch(0xdfff); // last low surrogate

// [label, string] — must throw with a message naming a control character.
export const CONTROL_REJECTS = [
  ['NUL (U+0000)', 'a' + ch(0x00) + 'b'],
  ['tab (U+0009)', 'a' + ch(0x09) + 'b'],
  ['line feed (U+000A)', 'line1' + ch(0x0a) + 'line2'],
  ['carriage return (U+000D)', 'a' + ch(0x0d) + 'b'],
  ['ESC (U+001B)', 'a' + ch(0x1b) + 'b'],
  ['last C0 (U+001F)', 'a' + ch(0x1f) + 'b'],
  ['DEL (U+007F)', 'a' + ch(0x7f) + 'b'],
  ['first C1 (U+0080)', 'a' + ch(0x80) + 'b'],
  ['NEL (U+0085)', 'a' + ch(0x85) + 'b'],
  ['last C1 (U+009F)', 'a' + ch(0x9f) + 'b'],
  ['leading C1 — rejected, not trimmed', ch(0x85) + 'ab'],
  ['trailing C1 — rejected, not trimmed', 'ab' + ch(0x85)],
  ['trailing line feed — rejected, not trimmed', 'ab' + ch(0x0a)],
  // Check order is part of four-site parity: the conformance verifier puts the
  // message in operator-visible output, so every site must report the same
  // reason for the same record. Control character wins over unpaired surrogate.
  ['C1 control AND unpaired surrogate together — reported as a control character', 'a' + ch(0x85) + HI],
];

// [label, string] — must throw with a message naming an unpaired surrogate.
export const SURROGATE_REJECTS = [
  ['lone high surrogate', 'a' + HI + 'b'],
  ['lone low surrogate', 'a' + LO + 'b'],
  ['lone last-high surrogate (U+DBFF)', 'a' + HI_LAST + 'b'],
  ['lone last-low surrogate (U+DFFF)', 'a' + LO_LAST + 'b'],
  ['reversed pair (low then high)', LO + HI],
  ['high surrogate at end of string', 'ab' + HI],
  ['low surrogate at start of string', LO + 'ab'],
  ['high + valid pair (first high is unpaired)', HI + HI + LO],
  ['valid pair + low (trailing low is unpaired)', HI + LO + LO],
  ['pair split by a character', HI + 'a' + LO],
];

// [label, input, expected normalized output] — must NOT throw.
export const ACCEPTS = [
  ['printable ASCII boundary U+007E (tilde)', 'a' + ch(0x7e) + 'b', 'a' + ch(0x7e) + 'b'],
  ['NBSP U+00A0 — first code point after C1, preserved even at the edges',
    ch(0xa0) + 'padded' + ch(0xa0), ch(0xa0) + 'padded' + ch(0xa0)],
  ['soft hyphen U+00AD (category Cf, not Cc)', 'a' + ch(0xad) + 'b', 'a' + ch(0xad) + 'b'],
  ['line separator U+2028 (category Zl, not Cc)', 'a' + ch(0x2028) + 'b', 'a' + ch(0x2028) + 'b'],
  ['valid surrogate pair (U+1F600)', 'a' + ch(0xd83d) + ch(0xde00) + 'b', 'a' + ch(0xd83d) + ch(0xde00) + 'b'],
  ['first astral code point (U+10000)', HI + LO, HI + LO],
  ['last astral code point (U+10FFFF)', HI_LAST + LO_LAST, HI_LAST + LO_LAST],
  ['U+D7FF — last code point before the surrogate block', 'a' + ch(0xd7ff) + 'b', 'a' + ch(0xd7ff) + 'b'],
  ['U+E000 — first code point after the surrogate block', 'a' + ch(0xe000) + 'b', 'a' + ch(0xe000) + 'b'],
  ['U+FFFF — last BMP code unit', 'a' + ch(0xffff) + 'b', 'a' + ch(0xffff) + 'b'],
  ['ASCII-space trim still applies', '  padded  ', 'padded'],
  ['NFC still applies (e + U+0301 composes)', 'caf' + 'e' + ch(0x301), 'caf' + ch(0xe9)],
];

function messageOf(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Run the full table against one normalizeString implementation.
 * `pass` / `fail` are the calling test file's own bookkeeping callbacks.
 */
export function runNormalizationCases(normalizeString, site, pass, fail) {
  for (const [label, input] of CONTROL_REJECTS) {
    const msg = messageOf(() => normalizeString(input));
    if (msg !== null && msg.includes('control character')) pass(`[${site}] rejects ${label}`);
    else fail(`[${site}] rejects ${label}`, `got ${msg === null ? 'no throw' : JSON.stringify(msg)}`);
  }

  for (const [label, input] of SURROGATE_REJECTS) {
    const msg = messageOf(() => normalizeString(input));
    if (msg !== null && msg.includes('unpaired surrogate')) pass(`[${site}] rejects ${label}`);
    else fail(`[${site}] rejects ${label}`, `got ${msg === null ? 'no throw' : JSON.stringify(msg)}`);
  }

  for (const [label, input, expected] of ACCEPTS) {
    let out;
    const msg = messageOf(() => { out = normalizeString(input); });
    if (msg === null && out === expected) pass(`[${site}] accepts ${label}`);
    else fail(`[${site}] accepts ${label}`, msg === null ? `got ${JSON.stringify(out)}` : `threw ${JSON.stringify(msg)}`);
  }

  // Exhaustive over every BMP code unit, embedded as 'a' + unit + 'b'. A
  // surrogate unit embedded this way is unpaired by construction. The
  // expectation comes from the numeric ranges above.
  const wrong = [];
  for (let cp = 0; cp <= 0xffff; cp++) {
    const input = 'a' + ch(cp) + 'b';
    const shouldReject = isControl(cp) || isSurrogateUnit(cp);
    let out;
    const msg = messageOf(() => { out = normalizeString(input); });
    const ok = shouldReject ? msg !== null : msg === null && out === input.normalize('NFC');
    if (!ok) wrong.push('U+' + cp.toString(16).toUpperCase().padStart(4, '0'));
  }
  if (wrong.length === 0) {
    pass(`[${site}] exhaustive BMP sweep: rejects exactly Cc (65 code points) + unpaired surrogates (2048 units), accepts the rest unchanged`);
  } else {
    fail(`[${site}] exhaustive BMP sweep`, `${wrong.length} wrong, first: ${wrong.slice(0, 8).join(', ')}`);
  }
}
