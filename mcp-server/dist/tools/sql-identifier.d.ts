/**
 * True iff `name` is a plain SQL identifier safe to place in a query as a quoted
 * column/table name. Accepts `unknown` so it can vet caller-supplied keys.
 */
export declare function isSafeIdentifier(name: unknown): boolean;
/**
 * Validate `name` as a plain SQL identifier and return it escaped (double-quoted,
 * embedded quotes doubled) for safe interpolation into SQL text. Throws on an
 * unsafe identifier so callers fail closed — never silently emit unescaped text.
 */
export declare function quoteIdentifier(name: string): string;
//# sourceMappingURL=sql-identifier.d.ts.map