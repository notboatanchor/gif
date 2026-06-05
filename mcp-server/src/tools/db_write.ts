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

// src/tools/db_write.ts
// =============================================================================
// db_write tool handler
// Writes to the GIF Postgres database with persona scope validation.
//
// Scope checks performed before execution:
//   1. permitted_actions must include 'write'
//   2. target table must be in output_destinations if that field is defined
//
// Only tables in the GIF schema are writable. A hardcoded allowlist
// prevents writes to core governance tables (personas, audit_events,
// scope_violations) which must never be written to via the tool layer.
//
// ADR-008: MCP server as the AI tool interface layer
// ADR-009: Persona-based permissions as infrastructure
// =============================================================================

import pool from '../db.js';
import { Persona, logScopeViolation, EnforcementLayer } from '../persona.js';
import type { ToolHandler } from './types.js';
import { isSafeIdentifier, quoteIdentifier } from './sql-identifier.js';

// ----------------------------------------------------------------------------
// Table allowlist
// Core governance tables are explicitly excluded — they are written to
// only by the MCP server internals, never via the db_write tool.
// ----------------------------------------------------------------------------

// GIF schema tables writable via db_write. Adopters: add domain-specific table names here.
// Core governance tables (personas, audit_events, scope_violations, etc.) are
// intentionally excluded — they are managed by the enforcement engine, never via tool calls.
const ALLOWED_WRITE_TABLES = new Set([
  'user_persona_assignments',
]);

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface DbWriteArgs {
  persona_id: string;
  table:      string;
  record:     string;  // JSON string — parsed at runtime
}

// ----------------------------------------------------------------------------
// Scope validation
// ----------------------------------------------------------------------------

function checkDbWriteScope(
  persona: Persona,
  table: string
): string | null {

  const scope = persona.scope_definition;

  // Fail-closed: absent or empty permitted_actions is a scope violation, not a pass.
  if (!scope.permitted_actions || !scope.permitted_actions.includes('write')) {
    return `Persona ${persona.persona_id} does not have 'write' in permitted_actions`;
  }

  // Fail-closed: absent or empty output_destinations is a scope violation, not a pass.
  if (!scope.output_destinations || !scope.output_destinations.includes(table)) {
    return `Persona ${persona.persona_id} does not have '${table}' in output_destinations`;
  }

  return null;
}

// ----------------------------------------------------------------------------
// executeDbWrite()
// ----------------------------------------------------------------------------

export async function executeDbWrite(
  args: DbWriteArgs,
  persona: Persona,
  sessionId: string
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {

  const { table, record } = args;

  // Allowlist check — before scope check
  if (!ALLOWED_WRITE_TABLES.has(table)) {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: `Table '${table}' is not writable via db_write`,
      }) }],
      isError: true,
    };
  }

  // Scope check
  const scopeError = checkDbWriteScope(persona, table);
  if (scopeError) {
    await logScopeViolation({
      personaId:       args.persona_id,
      sessionId,
      attemptedAction: 'write',
      toolName:        'db_write',
      blockedAt:       'mcp_validation' as EnforcementLayer,
      context:         { table, record },
    });
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: scopeError }) }],
      isError: true,
    };
  }

  // Parse record JSON string
  let parsedRecord: Record<string, unknown>;
  try {
    parsedRecord = JSON.parse(record) as Record<string, unknown>;
  } catch {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: `record must be a valid JSON string, e.g. {"key":"value"}`,
      }) }],
      isError: true,
    };
  }

  const columns = Object.keys(parsedRecord);
  if (columns.length === 0) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'record must have at least one field' }) }],
      isError: true,
    };
  }

  // Build the INSERT.
  //   - Table name: allowlisted above; quoteIdentifier re-validates + escapes it.
  //   - Column names are caller-supplied (JSON.parse of `record`) and become SQL
  //     identifiers. They cannot be parameterized, so each is validated as a
  //     plain identifier and escaped — a bare `"${c}"` interpolation here is an
  //     injection vector. Values are parameterized ($1, $2, ...).
  const invalidColumn = columns.find((c) => !isSafeIdentifier(c));
  if (invalidColumn !== undefined) {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: 'Invalid column name: not a valid column identifier',
      }) }],
      isError: true,
    };
  }

  // Construct + run inside the try so a defensive quoteIdentifier throw (every
  // column is already validated above, so this is belt-and-suspenders) returns a
  // clean tool error rather than escaping the handler.
  try {
    const columnList = columns.map(c => quoteIdentifier(c)).join(', ');
    const valuePlaceholders = columns.map((_, i) => `$${String(i + 1)}`).join(', ');
    const values = columns.map(c => parsedRecord[c]);

    const query = `
      INSERT INTO ${quoteIdentifier(table)} (${columnList})
      VALUES (${valuePlaceholders})
      RETURNING *
    `;

    const result = await pool.query(query, values);

    return {
      content: [{ type: 'text', text: JSON.stringify({
        table,
        inserted: result.rows[0] as Record<string, unknown>,
      }) }],
    };

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[db_write] Insert failed on table ${table}:`, message);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'Write failed due to an internal error' }) }],
      isError: true,
    };
  }
}

// ----------------------------------------------------------------------------
// ToolHandler export — consumed by the tool registry in index.ts
// ----------------------------------------------------------------------------

export const handler: ToolHandler = {
  definition: {
    name: 'db_write',
    description: 'Write to the GIF Postgres database. Persona scope and output destinations are validated before execution.',
    inputSchema: {
      type: 'object',
      properties: {
        persona_id:     { type: 'string', format: 'uuid', description: 'UUID of the active persona' },
        gif_session_id: { type: 'string', format: 'uuid', description: 'Governance session handle returned by session_start (GIF-019/020)' },
        table:          { type: 'string', minLength: 1, description: 'Table name to write to' },
        record:         { type: 'string', description: 'JSON string of the record to insert e.g. {"key":"value"}' },
      },
      required: ['persona_id', 'gif_session_id', 'table', 'record'],
    },
  },
  execute: (args, persona, sessionId) =>
    executeDbWrite(
      {
        persona_id: args['persona_id'] as string,
        table:      args['table'] as string,
        record:     args['record'] as string,
      },
      persona,
      sessionId
    ),
};