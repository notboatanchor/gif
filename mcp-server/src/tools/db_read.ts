// src/tools/db_read.ts
// =============================================================================
// db_read tool handler
// Reads from the GIF Postgres database with persona scope validation.
//
// Scope checks performed before execution:
//   1. permitted_actions must include 'read'
//   2. requested table must be in permitted_sources if that field is defined
//
// Only tables in the GIF schema are accessible. A hardcoded allowlist
// prevents arbitrary table access even if persona scope is broad.
//
// ADR-008: MCP server as the AI tool interface layer
// ADR-009: Persona-based permissions as infrastructure
// =============================================================================

import pool from '../db.js';
import { Persona, logScopeViolation, logAuditRead, EnforcementLayer } from '../persona.js';
import type { ToolHandler } from './types.js';

// ----------------------------------------------------------------------------
// Table allowlist
// Only these tables may be queried via db_read regardless of persona scope.
// Prevents access to Postgres system tables or future tables not yet
// considered in the permission model.
// Add tables here as new schema extensions are deployed.
// ----------------------------------------------------------------------------

const ALLOWED_READ_TABLES = new Set([
  'personas',
  'audit_events',
  'scope_violations',
  'delegation_chain',
  'revocation_log',
  'sessions',
  'entities',
  'relationships',
  'research_runs',
  'research_configurations',
  'search_results',
  'source_registry',
  'gap_analysis',
  'synthesis_outputs',
  'tool_registry',
  'user_persona_assignments',
  'erasure_log',
  'audit_chain_anchors',   // Sprint 5: hash chain anchor table
  'retention_holds',       // Sprint 5: legal hold table
]);

// Tables whose reads are logged to audit_read_log (Sprint 5 — chain of custody)
const AUDIT_CLASS_TABLES = new Set([
  'audit_events',
  'scope_violations',
  'revocation_log',
  'erasure_log',
  'audit_chain_anchors',
]);

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface DbReadArgs {
  persona_id: string;
  table:      string;
  filters?:   string;  // JSON string — parsed at runtime
  limit:      number;
}

// ----------------------------------------------------------------------------
// Scope validation
// ----------------------------------------------------------------------------

function checkDbReadScope(
  persona: Persona,
  table: string
): string | null {

  const scope = persona.scope_definition;

  // Fail-closed: absent or empty permitted_actions is a scope violation, not a pass.
  if (!scope.permitted_actions || !scope.permitted_actions.includes('read')) {
    return `Persona ${persona.persona_id} does not have 'read' in permitted_actions`;
  }

  // Fail-closed: absent or empty permitted_sources is a scope violation, not a pass.
  if (!scope.permitted_sources || !scope.permitted_sources.includes(table)) {
    return `Persona ${persona.persona_id} does not have '${table}' in permitted_sources`;
  }

  return null;
}

// ----------------------------------------------------------------------------
// executeDbRead()
// ----------------------------------------------------------------------------

export async function executeDbRead(
  args: DbReadArgs,
  persona: Persona,
  sessionId: string
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {

  const { table, filters, limit } = args;

  // Allowlist check — before scope check to avoid leaking table names
  if (!ALLOWED_READ_TABLES.has(table)) {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: `Table '${table}' is not accessible via db_read`,
      }) }],
      isError: true,
    };
  }

  // Scope check
  const scopeError = checkDbReadScope(persona, table);
  if (scopeError) {
    await logScopeViolation({
      personaId:       args.persona_id,
      sessionId,
      attemptedAction: 'read',
      toolName:        'db_read',
      blockedAt:       'mcp_validation' as EnforcementLayer,
      context:         { table, filters, limit },
    });
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: scopeError }) }],
      isError: true,
    };
  }

  // Parse filters JSON string if provided
  let parsedFilters: Record<string, unknown> = {};
  if (filters) {
    try {
      parsedFilters = JSON.parse(filters) as Record<string, unknown>;
    } catch {
      return {
        content: [{ type: 'text', text: JSON.stringify({
          error: `filters must be a valid JSON string, e.g. {"status":"active"}`,
        }) }],
        isError: true,
      };
    }
  }

  // Build parameterized query
  // Table name is validated against allowlist above — safe to interpolate.
  // Filter values are parameterized — no SQL injection possible.
  const filterKeys = Object.keys(parsedFilters);
  const whereClauses = filterKeys.map((key, i) => `"${key}" = $${String(i + 1)}`);
  const whereString = whereClauses.length > 0
    ? `WHERE ${whereClauses.join(' AND ')}`
    : '';
  const filterValues = filterKeys.map(key => parsedFilters[key]);

  // Append limit as the last parameter
  const limitParam = `$${String(filterValues.length + 1)}`;
  const query = `SELECT * FROM "${table}" ${whereString} LIMIT ${limitParam}`;

  try {
    const result = await pool.query(query, [...filterValues, limit]);

    // Log reads against audit-class tables for chain-of-custody (Sprint 5).
    // Fire-and-forget: failure must not mask the read response.
    if (AUDIT_CLASS_TABLES.has(table)) {
      void logAuditRead({
        readerPersonaId:  persona.persona_id,
        readerSessionId:  sessionId,
        queriedTable:     table,
        filtersApplied:   Object.keys(parsedFilters).length > 0 ? parsedFilters : undefined,
        rowsReturned:     result.rows.length,
        purposeDeclared:  persona.purpose,
      });
    }

    return {
      content: [{ type: 'text', text: JSON.stringify({
        table,
        row_count: result.rows.length,
        rows:      result.rows,
      }) }],
    };

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[db_read] Query failed on table ${table}:`, message);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: `Query failed: ${message}` }) }],
      isError: true,
    };
  }
}

// ----------------------------------------------------------------------------
// ToolHandler export — consumed by the tool registry in index.ts
// ----------------------------------------------------------------------------

export const handler: ToolHandler = {
  definition: {
    name: 'db_read',
    description: 'Read from the GIF Postgres database. Persona scope is validated before execution.',
    inputSchema: {
      type: 'object',
      properties: {
        persona_id: { type: 'string', format: 'uuid', description: 'UUID of the active persona' },
        table:      { type: 'string', minLength: 1, description: 'Table name to query' },
        filters:    { type: 'string', description: 'Optional JSON string of filter conditions e.g. {"status":"active"}' },
        limit:      { type: 'number', minimum: 1, maximum: 1000, default: 100, description: 'Maximum rows to return' },
      },
      required: ['persona_id', 'table'],
    },
  },
  execute: (args, persona, sessionId) =>
    executeDbRead(
      {
        persona_id: args['persona_id'] as string,
        table:      args['table'] as string,
        filters:    args['filters'] as string | undefined,
        limit:      (args['limit'] as number | undefined) ?? 100,
      },
      persona,
      sessionId
    ),
};
