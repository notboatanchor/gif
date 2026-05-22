"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
// src/cli/issue_identity_token.ts
// =============================================================================
// Admin CLI: generate a one-time HMAC-signed identity token for persona_create.
//
// Usage:
//   npx ts-node src/cli/issue_identity_token.ts --assignment-id <UUID>
//
// Prerequisites:
//   - IDENTITY_HMAC_SECRET must be in the environment (source .env or export).
//   - A gif.user_persona_assignments row must already exist for the given UUID.
//   - The assignment must have token_consumed = false and revoked_at IS NULL.
//
// Token format:
//   base64url(JSON.stringify({ assignment_id, issued_at })) + "." + hmac_hex
//
// The token is valid for 15 minutes from issuance (enforced at verification
// time in enforcement.ts:_verifyIdentityBinding). Single-use — consumed
// atomically when persona_create accepts it.
//
// Output: the token string on stdout. Paste into persona_create as identity_token.
//
// Sprint 5: Compliance Hardening — identity binding (ADR-021)
// =============================================================================
const crypto_1 = require("crypto");
// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------
function issueToken(assignmentId) {
    const secret = process.env['IDENTITY_HMAC_SECRET'];
    if (!secret) {
        throw new Error('IDENTITY_HMAC_SECRET is not set.\n' +
            'Export it or source your .env file before running this command.');
    }
    const payload = Buffer.from(JSON.stringify({
        assignment_id: assignmentId,
        issued_at: new Date().toISOString(),
    })).toString('base64url');
    const hmac = (0, crypto_1.createHmac)('sha256', secret).update(payload).digest('hex');
    return `${payload}.${hmac}`;
}
// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const assignmentIdIndex = argv.indexOf('--assignment-id');
if (assignmentIdIndex === -1 || !argv[assignmentIdIndex + 1]) {
    process.stderr.write('Usage: npx ts-node src/cli/issue_identity_token.ts --assignment-id <UUID>\n\n' +
        'The UUID must match an active, unconsumed row in gif.user_persona_assignments.\n' +
        'For first-time setup (no assignments exist yet), see\n' +
        '  docs/runbooks/adopter/first-time-setup.md#9-bootstrap-the-first-persona\n');
    process.exit(1);
}
const assignmentId = argv[assignmentIdIndex + 1];
try {
    const token = issueToken(assignmentId);
    process.stdout.write(token + '\n');
}
catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
}
//# sourceMappingURL=issue_identity_token.js.map