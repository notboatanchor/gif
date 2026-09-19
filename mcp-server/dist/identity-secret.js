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
// src/identity-secret.ts
// =============================================================================
// IDENTITY_HMAC_SECRET security floor.
//
// Internal helper — NOT re-exported from enforcement.ts. package.json's
// `exports` map publishes only dist/enforcement.js as the adopter-facing
// package entry point; this module has no adopter-facing purpose and must
// not become part of that surface.
//
// Why this exists: `.env.example` ships IDENTITY_HMAC_SECRET set to
// `changeme-use-openssl-rand-hex-32` — a publicly known value, and (not
// coincidentally) exactly 32 characters, so a bare minimum-length check does
// not catch it. An operator who copies `.env.example` to `.env` without
// replacing that value runs a server whose identity-token signing key is
// public. Once the key is known (or merely short enough to brute-force),
// _verifyIdentityBinding's HMAC check in enforcement.ts stops meaning
// anything: timingSafeEqual only proves the provided signature matches one
// computed with *this* secret, the 15-minute token window only bounds how
// long a forged token stays usable, and single-use consumption only stops
// the same forged token being replayed twice. None of them verify that the
// signer was someone who was supposed to hold the secret — anyone can mint
// an unlimited stream of fresh, validly-signed identity tokens and walk
// through persona_create. This module rejects the known-bad value and
// anything below a minimum key size, independent of and prior to any HMAC
// computation.
// =============================================================================
// Minimum encoded length for IDENTITY_HMAC_SECRET, in UTF-8 bytes. This bounds
// the length of the string, not its entropy — entropy cannot be measured from
// the value. Within the `openssl rand -hex N` family the shortest value it
// admits is N=16: 32 hex characters, 128 bits. The documented command,
// `openssl rand -hex 32`, yields 64 characters (256 bits) and clears it with
// room to spare.
export const IDENTITY_HMAC_SECRET_MIN_BYTES = 32;
// Returns null when `secret` is usable as an IDENTITY_HMAC_SECRET; otherwise
// a short, human-readable problem string describing which rule it failed.
// The returned string never contains the secret value itself — it is safe
// to place directly in a console.error line, a thrown Error message, or an
// IdentityBindingResult.reason.
export function identitySecretProblem(secret) {
    // Rule 1: reject the .env.example placeholder family outright, regardless
    // of length. Case-insensitive, and matched anywhere in the value rather than
    // as a prefix: an env-file loader that keeps surrounding quotes or stray
    // whitespace would carry the placeholder past a prefix test, and at exactly
    // 32 characters the placeholder clears Rule 2 on its own. Randomly generated
    // hex cannot contain the word; for random base64 the odds are negligible.
    if (secret.toLowerCase().includes('changeme')) {
        return 'contains the .env.example placeholder ("changeme" — replace the value)';
    }
    // Rule 2: reject anything under the minimum key size. Measured in UTF-8
    // bytes, not UTF-16 code units (secret.length): bytes are what createHmac
    // keys on, and the byte count is never smaller than .length (eleven euro
    // signs are 11 code units but 33 bytes).
    const byteLength = Buffer.byteLength(secret, 'utf8');
    if (byteLength < IDENTITY_HMAC_SECRET_MIN_BYTES) {
        return `is only ${String(byteLength)} bytes — must be at least ${String(IDENTITY_HMAC_SECRET_MIN_BYTES)} bytes`;
    }
    return null;
}
//# sourceMappingURL=identity-secret.js.map