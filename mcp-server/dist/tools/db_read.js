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
import { logScopeViolation, logAuditRead } from '../persona.js';
import { isSafeIdentifier, quoteIdentifier } from './sql-identifier.js';
// ----------------------------------------------------------------------------
// Table allowlist
// Only these tables may be queried via db_read regardless of persona scope.
// Prevents access to Postgres system tables or future tables not yet
// considered in the permission model.
// Add tables here as new schema extensions are deployed.
// ----------------------------------------------------------------------------
// Tables requiring 'admin_read' in permitted_actions (lateral movement vector if
// freely readable by AI personas). Only human admin tooling should enumerate these.
const ADMIN_READ_TABLES = new Set([
    'personas',
]);
// GIF schema tables. Adopters: add domain-specific table names here.
const ALLOWED_READ_TABLES = new Set([
    'audit_events',
    'scope_violations',
    'delegation_chain',
    'revocation_log',
    'sessions',
    'tool_registry',
    'user_persona_assignments',
    'erasure_log',
    'audit_chain_anchors', // Sprint 5: hash chain anchor table
    'retention_holds', // Sprint 5: legal hold table
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
// Scope validation
// ----------------------------------------------------------------------------
function checkDbReadScope(persona, table) {
    const scope = persona.scope_definition;
    const requiredAction = ADMIN_READ_TABLES.has(table) ? 'admin_read' : 'read';
    // Fail-closed: absent or empty permitted_actions is a scope violation, not a pass.
    if (!scope.permitted_actions || !scope.permitted_actions.includes(requiredAction)) {
        return `Persona ${persona.persona_id} does not have '${requiredAction}' in permitted_actions`;
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
export async function executeDbRead(args, persona, sessionId) {
    const { table, filters, limit } = args;
    // Allowlist check — before scope check to avoid leaking table names
    if (!ALLOWED_READ_TABLES.has(table) && !ADMIN_READ_TABLES.has(table)) {
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
            personaId: args.persona_id,
            sessionId,
            attemptedAction: 'read',
            toolName: 'db_read',
            blockedAt: 'mcp_validation',
            context: { table, filters, limit },
        });
        return {
            content: [{ type: 'text', text: JSON.stringify({ error: scopeError }) }],
            isError: true,
        };
    }
    // Parse filters JSON string if provided
    let parsedFilters = {};
    if (filters) {
        try {
            parsedFilters = JSON.parse(filters);
        }
        catch {
            return {
                content: [{ type: 'text', text: JSON.stringify({
                            error: `filters must be a valid JSON string, e.g. {"status":"active"}`,
                        }) }],
                isError: true,
            };
        }
    }
    // Build the query.
    //   - Table name: allowlisted above; quoteIdentifier re-validates + escapes it.
    //   - Filter KEYS are caller-supplied (JSON.parse of `filters`) and become SQL
    //     identifiers. They cannot be parameterized, so each is validated as a
    //     plain identifier and escaped — a bare `"${key}"` interpolation here is an
    //     injection vector (e.g. a key of  id" = id OR pg_sleep(10) ... --  ).
    //   - Filter VALUES are parameterized ($1, $2, ...).
    const filterKeys = Object.keys(parsedFilters);
    const invalidKey = filterKeys.find((key) => !isSafeIdentifier(key));
    if (invalidKey !== undefined) {
        return {
            content: [{ type: 'text', text: JSON.stringify({
                        error: 'Invalid filter key: not a valid column identifier',
                    }) }],
            isError: true,
        };
    }
    // Construct + run inside the try so a defensive quoteIdentifier throw (every
    // key is already validated above, so this is belt-and-suspenders) returns a
    // clean tool error rather than escaping the handler.
    try {
        const whereClauses = filterKeys.map((key, i) => `${quoteIdentifier(key)} = $${String(i + 1)}`);
        const whereString = whereClauses.length > 0
            ? `WHERE ${whereClauses.join(' AND ')}`
            : '';
        const filterValues = filterKeys.map(key => parsedFilters[key]);
        // Append limit as the last parameter
        const limitParam = `$${String(filterValues.length + 1)}`;
        const query = `SELECT * FROM ${quoteIdentifier(table)} ${whereString} LIMIT ${limitParam}`;
        const result = await pool.query(query, [...filterValues, limit]);
        // Log reads against audit-class tables for chain-of-custody (Sprint 5).
        // Fire-and-forget: failure must not mask the read response.
        if (AUDIT_CLASS_TABLES.has(table)) {
            void logAuditRead({
                readerPersonaId: persona.persona_id,
                readerSessionId: sessionId,
                queriedTable: table,
                filtersApplied: Object.keys(parsedFilters).length > 0 ? parsedFilters : undefined,
                rowsReturned: result.rows.length,
                purposeDeclared: persona.purpose,
            });
        }
        return {
            content: [{ type: 'text', text: JSON.stringify({
                        table,
                        row_count: result.rows.length,
                        rows: result.rows,
                    }) }],
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[db_read] Query failed on table ${table}:`, message);
        return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Query failed due to an internal error' }) }],
            isError: true,
        };
    }
}
// ----------------------------------------------------------------------------
// ToolHandler export — consumed by the tool registry in index.ts
// ----------------------------------------------------------------------------
export const handler = {
    definition: {
        name: 'db_read',
        description: 'Read from the GIF Postgres database. Persona scope is validated before execution.',
        inputSchema: {
            type: 'object',
            properties: {
                persona_id: { type: 'string', format: 'uuid', description: 'UUID of the active persona' },
                gif_session_id: { type: 'string', format: 'uuid', description: 'Governance session handle returned by session_start (GIF-019/020)' },
                table: { type: 'string', minLength: 1, description: 'Table name to query' },
                filters: { type: 'string', description: 'Optional JSON string of filter conditions e.g. {"status":"active"}' },
                limit: { type: 'number', minimum: 1, maximum: 1000, default: 100, description: 'Maximum rows to return' },
            },
            required: ['persona_id', 'gif_session_id', 'table'],
        },
    },
    execute: (args, persona, sessionId) => executeDbRead({
        persona_id: args['persona_id'],
        table: args['table'],
        filters: args['filters'],
        limit: args['limit'] ?? 100,
    }, persona, sessionId),
};
//# sourceMappingURL=db_read.js.map