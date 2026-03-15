"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeDbRead = executeDbRead;
const db_js_1 = __importDefault(require("../db.js"));
const persona_js_1 = require("../persona.js");
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
]);
// ----------------------------------------------------------------------------
// Scope validation
// ----------------------------------------------------------------------------
function checkDbReadScope(persona, table) {
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
async function executeDbRead(args, persona, sessionId) {
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
        await (0, persona_js_1.logScopeViolation)({
            personaId: args.persona_id,
            sessionId,
            attemptedAction: 'read',
            toolName: 'db_read',
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
    // Build parameterized query
    // Table name is validated against allowlist above — safe to interpolate.
    // Filter values are parameterized — no SQL injection possible.
    const filterKeys = Object.keys(parsedFilters);
    const whereClauses = filterKeys.map((key, i) => `"${key}" = $${i + 1}`);
    const whereString = whereClauses.length > 0
        ? `WHERE ${whereClauses.join(' AND ')}`
        : '';
    const filterValues = filterKeys.map(key => parsedFilters[key]);
    // Append limit as the last parameter
    const limitParam = `$${filterValues.length + 1}`;
    const query = `SELECT * FROM "${table}" ${whereString} LIMIT ${limitParam}`;
    try {
        const result = await db_js_1.default.query(query, [...filterValues, limit]);
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
            content: [{ type: 'text', text: JSON.stringify({ error: `Query failed: ${message}` }) }],
            isError: true,
        };
    }
}
//# sourceMappingURL=db_read.js.map