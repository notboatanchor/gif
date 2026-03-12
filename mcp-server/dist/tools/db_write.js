"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeDbWrite = executeDbWrite;
const db_js_1 = __importDefault(require("../db.js"));
const persona_js_1 = require("../persona.js");
// ----------------------------------------------------------------------------
// Table allowlist
// Core governance tables are explicitly excluded — they are written to
// only by the MCP server internals, never via the db_write tool.
// ----------------------------------------------------------------------------
const ALLOWED_WRITE_TABLES = new Set([
    'entities',
    'relationships',
    'research_runs',
    'research_configurations',
    'search_results',
    'source_registry',
    'gap_analysis',
    'synthesis_outputs',
]);
// ----------------------------------------------------------------------------
// Scope validation
// ----------------------------------------------------------------------------
function checkDbWriteScope(persona, table) {
    const scope = persona.scope_definition;
    if (scope.permitted_actions && scope.permitted_actions.length > 0) {
        if (!scope.permitted_actions.includes('write')) {
            return `Persona ${persona.persona_id} does not have 'write' in permitted_actions`;
        }
    }
    // output_destinations — if defined, table must be listed
    if (scope.output_destinations && scope.output_destinations.length > 0) {
        if (!scope.output_destinations.includes(table)) {
            return `Persona ${persona.persona_id} does not have '${table}' in output_destinations`;
        }
    }
    return null;
}
// ----------------------------------------------------------------------------
// executeDbWrite()
// ----------------------------------------------------------------------------
async function executeDbWrite(args, persona, sessionId) {
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
        await (0, persona_js_1.logScopeViolation)({
            personaId: args.persona_id,
            sessionId,
            attemptedAction: 'write',
            toolName: 'db_write',
            context: { table, record },
        });
        return {
            content: [{ type: 'text', text: JSON.stringify({ error: scopeError }) }],
            isError: true,
        };
    }
    // Parse record JSON string
    let parsedRecord;
    try {
        parsedRecord = JSON.parse(record);
    }
    catch {
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
    // Build parameterized INSERT
    // Table name validated against allowlist — safe to interpolate.
    // Column names are quoted. Values are parameterized.
    const columnList = columns.map(c => `"${c}"`).join(', ');
    const valuePlaceholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    const values = columns.map(c => parsedRecord[c]);
    const query = `
    INSERT INTO "${table}" (${columnList})
    VALUES (${valuePlaceholders})
    RETURNING *
  `;
    try {
        const result = await db_js_1.default.query(query, values);
        return {
            content: [{ type: 'text', text: JSON.stringify({
                        table,
                        inserted: result.rows[0],
                    }) }],
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[db_write] Insert failed on table ${table}:`, message);
        return {
            content: [{ type: 'text', text: JSON.stringify({ error: `Write failed: ${message}` }) }],
            isError: true,
        };
    }
}
//# sourceMappingURL=db_write.js.map