/**
 * Returns the name of the first field in `required` that is absent from
 * `args` (undefined or null), or null when every required argument is
 * present. persona_id and gif_session_id are skipped — the dispatcher
 * validates those separately.
 */
export declare function findMissingRequiredArg(required: readonly string[] | undefined, args: Record<string, unknown>): string | null;
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
export declare function nonEmptyStringArgError(fields: ReadonlyArray<readonly [name: string, value: unknown]>): string | null;
/**
 * Returns an error message unless `value` — the result of JSON.parse on a
 * caller-supplied argument — is a plain JSON object. JSON.parse accepts
 * 'null', arrays, and scalars, none of which the object-shaped arguments
 * (filters, record, scope_definition) may be: 'null' in particular would
 * crash Object.keys() in db_read/db_write, and in persona_create would
 * persist a JSON null into the JSONB NOT NULL scope_definition column
 * (JSON null is not SQL NULL, so the constraint does not catch it).
 */
export declare function jsonObjectArgError(value: unknown, field: string): string | null;
//# sourceMappingURL=arg-guards.d.ts.map