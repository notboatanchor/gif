"use strict";
// src/tools/persona_create.ts
// =============================================================================
// persona_create tool handler
// Creates a new persona in the GIF registry.
//
// Scope checks:
//   - Issuing persona must have 'manage_personas' in permitted_actions.
//
// The issuing persona's session and audit trail record the creation event.
// The new persona_id is returned and captured in source_ref on the audit event.
//
// Persona lifecycle audit events use event_type='persona_create' rather
// than 'tool_call' to make them first-class in the audit trail and
// distinguishable in point-in-time reconstruction.
//
// ADR-008: MCP server as the AI tool interface layer
// ADR-009: Persona-based permissions as infrastructure
// ADR-017: Governance audit schema stubs
// =============================================================================
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.executePersonaCreate = executePersonaCreate;
const db_js_1 = __importDefault(require("../db.js"));
const persona_js_1 = require("../persona.js");
// ----------------------------------------------------------------------------
// executePersonaCreate()
// ----------------------------------------------------------------------------
async function executePersonaCreate(args, persona, sessionId) {
    // Scope check — issuer must have manage_personas
    const scope = persona.scope_definition;
    if (!scope.permitted_actions || !scope.permitted_actions.includes('manage_personas')) {
        await (0, persona_js_1.logScopeViolation)({
            personaId: args.persona_id,
            sessionId,
            attemptedAction: 'manage_personas',
            toolName: 'persona_create',
            blockedAt: 'mcp_validation',
            context: { issuing_entity: args.issuing_entity, purpose: args.purpose },
        });
        return {
            content: [{ type: 'text', text: JSON.stringify({
                        error: `Persona ${args.persona_id} does not have 'manage_personas' in permitted_actions`,
                    }) }],
            isError: true,
        };
    }
    // Parse scope_definition
    let parsedScope;
    try {
        parsedScope = JSON.parse(args.scope_definition);
    }
    catch {
        return {
            content: [{ type: 'text', text: JSON.stringify({
                        error: 'scope_definition must be a valid JSON string',
                    }) }],
            isError: true,
        };
    }
    // Insert new persona
    try {
        const result = await db_js_1.default.query(`INSERT INTO personas (
         issuing_entity,
         purpose,
         created_by,
         scope_definition,
         valid_from,
         valid_until,
         max_delegation_depth,
         parent_persona_id
       ) VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()), $6, $7, $8)
       RETURNING persona_id`, [
            args.issuing_entity,
            args.purpose,
            args.created_by,
            JSON.stringify(parsedScope),
            args.valid_from ?? null,
            args.valid_until,
            args.max_delegation_depth ?? 0,
            args.parent_persona_id ?? null,
        ]);
        const newPersonaId = result.rows[0].persona_id;
        return {
            content: [{ type: 'text', text: JSON.stringify({
                        persona_id: newPersonaId,
                        issuing_entity: args.issuing_entity,
                        purpose: args.purpose,
                        created_by: args.created_by,
                        valid_until: args.valid_until,
                        created: true,
                    }) }],
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[persona_create] Insert failed:`, message);
        return {
            content: [{ type: 'text', text: JSON.stringify({ error: `Persona creation failed: ${message}` }) }],
            isError: true,
        };
    }
}
//# sourceMappingURL=persona_create.js.map