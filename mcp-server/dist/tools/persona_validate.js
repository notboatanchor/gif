"use strict";
// src/tools/persona_validate.ts
// =============================================================================
// persona_validate tool handler
// Validates a persona and returns its details if valid.
//
// Diagnostic tool — does not create a session or emit an audit event.
// skipSession: true — the enforcement engine validates the persona before
// calling execute(), but does not create a session record.
//
// Framework tool: ships with GIF enforcement engine (ADR-026).
//
// ADR-008: MCP server as the AI tool interface layer
// ADR-009: Persona-based permissions as infrastructure
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
exports.executePersonaValidate = executePersonaValidate;
// ----------------------------------------------------------------------------
// executePersonaValidate()
// Called only after the enforcement engine has already validated the persona.
// Returns the persona details in a consistent format.
// ----------------------------------------------------------------------------
async function executePersonaValidate(_args, persona, _sessionId) {
    return {
        content: [{
                type: 'text',
                text: JSON.stringify({
                    valid: true,
                    persona_id: persona.persona_id,
                    issuing_entity: persona.issuing_entity,
                    purpose: persona.purpose,
                    status: persona.status,
                    valid_from: persona.valid_from,
                    valid_until: persona.valid_until,
                    scope_definition: persona.scope_definition,
                }),
            }],
    };
}
// ----------------------------------------------------------------------------
// ToolHandler export — consumed by the tool registry in index.ts
// Framework tool: ships with GIF enforcement engine (ADR-026).
// skipSession: true — persona is validated but no session is created.
// ----------------------------------------------------------------------------
exports.handler = {
    definition: {
        name: 'persona_validate',
        description: 'Validate a persona by ID. Returns persona details if valid, error if not. Diagnostic — does not create a session.',
        inputSchema: {
            type: 'object',
            properties: {
                persona_id: { type: 'string', format: 'uuid', description: 'UUID of the persona to validate' },
            },
            required: ['persona_id'],
        },
    },
    execute: executePersonaValidate,
    skipSession: true,
};
//# sourceMappingURL=persona_validate.js.map