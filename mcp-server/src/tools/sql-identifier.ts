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

// src/tools/sql-identifier.ts
// =============================================================================
// SQL identifier safety
//
// db_read and db_write place caller-supplied object keys (filter columns,
// insert columns) into SQL text as quoted identifiers. The target table is
// allowlisted, but column / filter keys come straight from a JSON.parse of
// caller input — so they MUST be validated and escaped before they ever reach
// the query string. A bare `"${key}"` interpolation is injectable: a key such
// as  id" = id OR pg_sleep(10) IS NOT NULL --  breaks out of the quotes and
// injects arbitrary SQL. (Values are already parameterized; identifiers cannot
// be parameterized, so they need this separate control.)
//
// Defense in depth — two independent layers:
//   1. isSafeIdentifier — reject anything that is not a plain SQL identifier
//      (ASCII letter/underscore start, then letters/digits/underscores, capped
//      at 63 bytes = Postgres NAMEDATALEN - 1). gif schema columns are
//      snake_case ASCII, so this rejects no legitimate key.
//   2. quoteIdentifier — validate, THEN escape via pg's own escapeIdentifier
//      (which doubles embedded quotes). Even if layer 1 were ever loosened, the
//      escape keeps the interpolation injection-safe.
// =============================================================================

import { escapeIdentifier } from 'pg';

// Postgres identifiers are capped at NAMEDATALEN - 1 = 63 bytes by default.
const MAX_IDENTIFIER_LENGTH = 63;

// A plain, unqualified SQL identifier: an ASCII letter or underscore, then ASCII
// letters, digits, or underscores. Admits no quotes, whitespace, operators,
// dots, or comment markers — i.e. nothing that can break out of a quoted ident.
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * True iff `name` is a plain SQL identifier safe to place in a query as a quoted
 * column/table name. Accepts `unknown` so it can vet caller-supplied keys.
 */
export function isSafeIdentifier(name: unknown): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= MAX_IDENTIFIER_LENGTH &&
    SAFE_IDENTIFIER.test(name)
  );
}

/**
 * Validate `name` as a plain SQL identifier and return it escaped (double-quoted,
 * embedded quotes doubled) for safe interpolation into SQL text. Throws on an
 * unsafe identifier so callers fail closed — never silently emit unescaped text.
 */
export function quoteIdentifier(name: string): string {
  if (!isSafeIdentifier(name)) {
    throw new Error(`unsafe SQL identifier: ${JSON.stringify(name)}`);
  }
  return escapeIdentifier(name);
}
