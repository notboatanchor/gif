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
// src/tools/arg-guards.ts
// =============================================================================
// Tool-argument runtime guards
//
// The low-level MCP `Server` performs no JSON-Schema validation of tool
// inputSchemas (the SDK's validators wire into the `McpServer` and elicitation
// paths only) — every constraint a tool declares is enforced here or not at
// all. Two layers, split by where the failure should surface:
//
//   1. findMissingRequiredArg — dispatcher-level presence check over a tool
//      definition's `inputSchema.required`. A missing required argument is a
//      protocol-level InvalidParams throw and emits no audit — the same
//      treatment conformance C2.2 locks in for a missing gif_session_id.
//      persona_id and gif_session_id are excluded here: each keeps its
//      dedicated dispatcher check (load-bearing error messages, and for
//      session handles the audited rejection paths in validateSessionHandle
//      and session_close).
//
//   2. Handler-level value guards (nonEmptyStringArgError, jsonObjectArgError)
//      for present-but-invalid values: empty strings that satisfy NOT NULL but
//      bypass a declared `minLength: 1`, and JSON.parse results that are not
//      plain objects where an object is required. These reject inside the
//      handler as ordinary tool errors, so the dispatcher's audit emission
//      still records the attempt (outcome 'error').
//
// Without these guards, presence was enforced only by NOT NULL constraints at
// the persistence layer — one layer below the MCP enforcement point — and the
// declared minLength / minimum / maximum bounds were not enforced at all.
// =============================================================================
// Arguments the dispatcher validates with dedicated checks before the generic
// required-args pass; see index.ts.
const DISPATCHER_CHECKED_ARGS = new Set(['persona_id', 'gif_session_id']);
/**
 * Returns the name of the first field in `required` that is absent from
 * `args` (undefined or null), or null when every required argument is
 * present. persona_id and gif_session_id are skipped — the dispatcher
 * validates those separately.
 */
export function findMissingRequiredArg(required, args) {
    if (!required)
        return null;
    for (const field of required) {
        if (DISPATCHER_CHECKED_ARGS.has(field))
            continue;
        if (args[field] === undefined || args[field] === null)
            return field;
    }
    return null;
}
/**
 * Returns an error message if any of the named values is not a non-empty
 * string (the runtime form of `type: 'string', minLength: 1`), else null.
 * Deliberately stricter than the declared minLength on two counts:
 *
 * - Whitespace-only values are rejected — a purpose or reason of ' '
 *   satisfies minLength but carries zero governance content.
 * - Control characters (C0, DEL, and C1) are rejected. They survive `.trim()`
 *   (an embedded `\n` in a pasted multi-line string is the ordinary case),
 *   and a persona purpose carrying one is copied into `purpose_declared`
 *   on every audit row the persona generates — inside the hashed canonical
 *   form, whose verifier rejects control characters in protected strings
 *   (src/audit/verify-core.ts normalizeString). The trigger hashes such a
 *   row without complaint (it never throws), producing a row that can
 *   never be recomputed. No guarded governance-metadata string legitimately
 *   contains a control character, so the rule is applied to every field
 *   this helper covers, not just purpose. Deliberately WIDER than the
 *   verifier's rejection set (C0+DEL): C1 controls (U+0080-U+009F, e.g.
 *   NEL) pass the verifier and cannot poison the chain, but they are still
 *   control characters in governance text. A guard stricter than the
 *   verifier is divergence-safe; the verifier itself is canonical-form
 *   contract and is not widened here. Only the control-character half of
 *   the verifier's normalizeString is mirrored; its other rejection — the
 *   8192-char length cap (MAX_FIELD_LEN) — needs no input-boundary twin,
 *   because the one guarded value that reaches the hashed preimage
 *   (purpose, copied to purpose_declared) is bounded far below the cap by
 *   its VARCHAR(1000) column (schema/001_gif_core.sql:85).
 *
 * This is the audited in-handler value-guard path per GIF-022 §C2.7 — do
 * NOT express the control-character rule as an inputSchema `pattern`, which
 * would move the rejection to a pre-governance protocol throw.
 *
 * Takes [name, value] pairs so handlers can pass their already-typed args
 * without an index-signature cast.
 */
export function nonEmptyStringArgError(fields) {
    for (const [name, value] of fields) {
        if (typeof value !== 'string' || value.trim().length === 0) {
            return `${name} must be a non-empty string`;
        }
        if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) {
            return `${name} must not contain control characters`;
        }
    }
    return null;
}
/**
 * Returns an error message unless `value` — the result of JSON.parse on a
 * caller-supplied argument — is a plain JSON object. JSON.parse accepts
 * 'null', arrays, and scalars, none of which the object-shaped arguments
 * (filters, record, scope_definition) may be: 'null' in particular would
 * crash Object.keys() in db_read/db_write, and in persona_create would
 * persist a JSON null into the JSONB NOT NULL scope_definition column
 * (JSON null is not SQL NULL, so the constraint does not catch it).
 */
export function jsonObjectArgError(value, field) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return `${field} must be a JSON object, e.g. {"key":"value"}`;
    }
    return null;
}
//# sourceMappingURL=arg-guards.js.map