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
 * Deliberately stricter than the declared minLength: whitespace-only values
 * are rejected too — a purpose or reason of ' ' satisfies minLength but
 * carries zero governance content. Takes [name, value] pairs so handlers can
 * pass their already-typed args without an index-signature cast.
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