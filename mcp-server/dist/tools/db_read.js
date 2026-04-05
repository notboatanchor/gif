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
exports.handler = void 0;
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
async function executeDbRead(args, persona, sessionId) {
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
        await (0, persona_js_1.logScopeViolation)({
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
        const result = await db_js_1.default.query(query, [...filterValues, limit]);
        // Log reads against audit-class tables for chain-of-custody (Sprint 5).
        // Fire-and-forget: failure must not mask the read response.
        if (AUDIT_CLASS_TABLES.has(table)) {
            void (0, persona_js_1.logAuditRead)({
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
            content: [{ type: 'text', text: JSON.stringify({ error: `Query failed: ${message}` }) }],
            isError: true,
        };
    }
}
// ----------------------------------------------------------------------------
// ToolHandler export — consumed by the tool registry in index.ts
// ----------------------------------------------------------------------------
exports.handler = {
    definition: {
        name: 'db_read',
        description: 'Read from the GIF Postgres database. Persona scope is validated before execution.',
        inputSchema: {
            type: 'object',
            properties: {
                persona_id: { type: 'string', format: 'uuid', description: 'UUID of the active persona' },
                table: { type: 'string', minLength: 1, description: 'Table name to query' },
                filters: { type: 'string', description: 'Optional JSON string of filter conditions e.g. {"status":"active"}' },
                limit: { type: 'number', minimum: 1, maximum: 1000, default: 100, description: 'Maximum rows to return' },
            },
            required: ['persona_id', 'table'],
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