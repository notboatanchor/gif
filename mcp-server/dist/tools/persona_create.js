"use strict";
// src/tools/persona_create.ts
// =============================================================================
// persona_create tool handler
// Creates a new persona in the GIF registry.
//
// Scope checks:
//   - Issuing persona must have 'manage_personas' in permitted_actions.
//
// Delegation chain (Sprint 4):
//   - When parent_persona_id is provided, the child's scope is validated as
//     a strict subset of the parent's scope. A child persona cannot hold
//     permissions the parent does not hold — checked across permitted_actions,
//     permitted_sources, and output_destinations.
//   - If the child's scope exceeds the parent's, the call is rejected with a
//     scope violation record.
//   - If valid, a delegation_chain record is written atomically with the
//     persona INSERT.
//   - delegation_depth is parent depth + 1 (root personas have no chain entry;
//     their depth is treated as 0).
//   - Child max_delegation_depth must not exceed parent max_delegation_depth - 1.
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
exports.handler = void 0;
exports.executePersonaCreate = executePersonaCreate;
const db_js_1 = __importDefault(require("../db.js"));
const persona_js_1 = require("../persona.js");
// ----------------------------------------------------------------------------
// scopeIsSubset()
// Returns null if child scope is valid (subset of parent scope).
// Returns a description of the first violation found if not.
//
// Checks permitted_actions, permitted_sources, and output_destinations.
// A child may hold fewer permissions than the parent but never more.
// ----------------------------------------------------------------------------
function scopeIsSubset(childScope, parentScope) {
    const checks = [
        { field: 'permitted_actions', label: 'permitted_actions' },
        { field: 'permitted_sources', label: 'permitted_sources' },
        { field: 'output_destinations', label: 'output_destinations' },
    ];
    for (const { field, label } of checks) {
        const childValues = childScope[field];
        const parentValues = parentScope[field];
        if (!childValues || childValues.length === 0)
            continue;
        if (!parentValues || parentValues.length === 0) {
            return `Child requests ${label} [${childValues.join(', ')}] but parent has none`;
        }
        const parentSet = new Set(parentValues);
        const exceeds = childValues.filter(v => !parentSet.has(v));
        if (exceeds.length > 0) {
            return `Child ${label} [${exceeds.join(', ')}] not present in parent scope`;
        }
    }
    return null;
}
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
    // ---------------------------------------------------------------------------
    // Delegation chain validation (only when parent_persona_id is provided)
    // ---------------------------------------------------------------------------
    let parentDepth = 0;
    let delegationDepth = 0;
    if (args.parent_persona_id) {
        // Fetch parent persona scope and delegation constraints
        let parentPersona = null;
        try {
            const parentResult = await db_js_1.default.query(`SELECT scope_definition, max_delegation_depth
         FROM personas
         WHERE persona_id = $1 AND status = 'active'
         LIMIT 1`, [args.parent_persona_id]);
            if (parentResult.rows.length === 0) {
                return {
                    content: [{ type: 'text', text: JSON.stringify({
                                error: `Parent persona ${args.parent_persona_id} not found or not active`,
                            }) }],
                    isError: true,
                };
            }
            parentPersona = parentResult.rows[0];
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            return {
                content: [{ type: 'text', text: JSON.stringify({
                            error: `Failed to fetch parent persona: ${message}`,
                        }) }],
                isError: true,
            };
        }
        // Determine parent's current depth in the chain (0 if root)
        try {
            const depthResult = await db_js_1.default.query(`SELECT delegation_depth
         FROM delegation_chain
         WHERE child_persona_id = $1
         ORDER BY delegated_at DESC
         LIMIT 1`, [args.parent_persona_id]);
            parentDepth = depthResult.rows.length > 0 ? depthResult.rows[0].delegation_depth : 0;
            delegationDepth = parentDepth + 1;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            return {
                content: [{ type: 'text', text: JSON.stringify({
                            error: `Failed to determine delegation depth: ${message}`,
                        }) }],
                isError: true,
            };
        }
        // Check delegation depth does not exceed parent's max_delegation_depth
        if (delegationDepth > parentPersona.max_delegation_depth) {
            await (0, persona_js_1.logScopeViolation)({
                personaId: args.persona_id,
                sessionId,
                attemptedAction: 'delegate_persona',
                toolName: 'persona_create',
                blockedAt: 'mcp_validation',
                context: {
                    parent_persona_id: args.parent_persona_id,
                    attempted_depth: delegationDepth,
                    parent_max_depth: parentPersona.max_delegation_depth,
                },
            });
            return {
                content: [{ type: 'text', text: JSON.stringify({
                            error: `Delegation depth ${delegationDepth} exceeds parent max_delegation_depth ${parentPersona.max_delegation_depth}`,
                        }) }],
                isError: true,
            };
        }
        // Check child scope is a subset of parent scope
        const violation = scopeIsSubset(parsedScope, parentPersona.scope_definition);
        if (violation) {
            await (0, persona_js_1.logScopeViolation)({
                personaId: args.persona_id,
                sessionId,
                attemptedAction: 'delegate_persona',
                toolName: 'persona_create',
                blockedAt: 'mcp_validation',
                context: {
                    parent_persona_id: args.parent_persona_id,
                    scope_violation: violation,
                    child_scope: parsedScope,
                    parent_scope: parentPersona.scope_definition,
                },
            });
            return {
                content: [{ type: 'text', text: JSON.stringify({
                            error: `Child scope exceeds parent scope: ${violation}`,
                        }) }],
                isError: true,
            };
        }
    }
    // ---------------------------------------------------------------------------
    // Insert persona (and delegation_chain record if delegated) — atomic
    // ---------------------------------------------------------------------------
    try {
        await db_js_1.default.query('BEGIN');
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
        if (args.parent_persona_id) {
            await db_js_1.default.query(`INSERT INTO delegation_chain (
           parent_persona_id,
           child_persona_id,
           delegated_permissions,
           delegation_depth,
           delegated_by
         ) VALUES ($1, $2, $3, $4, $5)`, [
                args.parent_persona_id,
                newPersonaId,
                JSON.stringify(parsedScope),
                delegationDepth,
                args.created_by,
            ]);
        }
        await db_js_1.default.query('COMMIT');
        return {
            content: [{ type: 'text', text: JSON.stringify({
                        persona_id: newPersonaId,
                        issuing_entity: args.issuing_entity,
                        purpose: args.purpose,
                        created_by: args.created_by,
                        valid_until: args.valid_until,
                        parent_persona_id: args.parent_persona_id ?? null,
                        delegation_depth: args.parent_persona_id ? delegationDepth : null,
                        created: true,
                    }) }],
        };
    }
    catch (err) {
        await db_js_1.default.query('ROLLBACK');
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[persona_create] Transaction failed:`, message);
        return {
            content: [{ type: 'text', text: JSON.stringify({ error: `Persona creation failed: ${message}` }) }],
            isError: true,
        };
    }
}
// ----------------------------------------------------------------------------
// ToolHandler export — consumed by the tool registry in index.ts
// Framework tool: ships with GIF enforcement engine (ADR-026).
// Emits first-class persona_create audit event with source_ref = new persona_id.
// ----------------------------------------------------------------------------
exports.handler = {
    definition: {
        name: 'persona_create',
        description: 'Create a new persona in the GIF registry. Issuing persona must have manage_personas in permitted_actions.',
        inputSchema: {
            type: 'object',
            properties: {
                persona_id: { type: 'string', format: 'uuid', description: 'UUID of the issuing persona (must have manage_personas)' },
                issuing_entity: { type: 'string', minLength: 1, description: 'Name of the entity issuing the persona' },
                purpose: { type: 'string', minLength: 1, description: 'Human-readable declaration of business function' },
                created_by: { type: 'string', minLength: 1, description: 'Identity of the actor creating the persona' },
                scope_definition: { type: 'string', description: 'JSON string of scope: permitted_sources, permitted_actions, output_destinations, retention_policy' },
                valid_until: { type: 'string', description: 'ISO 8601 datetime when persona expires' },
                valid_from: { type: 'string', description: 'ISO 8601 datetime when persona becomes valid (defaults to now)' },
                max_delegation_depth: { type: 'number', minimum: 0, default: 0, description: 'Maximum delegation hops allowed (0 = no delegation)' },
                parent_persona_id: { type: 'string', format: 'uuid', description: 'UUID of parent persona for delegated scope (optional)' },
            },
            required: ['persona_id', 'issuing_entity', 'purpose', 'created_by', 'scope_definition', 'valid_until'],
        },
    },
    execute: (args, persona, sessionId) => executePersonaCreate({
        persona_id: args['persona_id'],
        issuing_entity: args['issuing_entity'],
        purpose: args['purpose'],
        created_by: args['created_by'],
        scope_definition: args['scope_definition'],
        valid_until: args['valid_until'],
        valid_from: args['valid_from'],
        max_delegation_depth: args['max_delegation_depth'],
        parent_persona_id: args['parent_persona_id'],
    }, persona, sessionId),
    auditMetadata: (_args, result) => {
        let sourceRef;
        if (!result.isError) {
            try {
                const parsed = JSON.parse(result.content[0].text);
                sourceRef = parsed['persona_id'];
            }
            catch { /* non-fatal */ }
        }
        return { eventType: 'persona_create', sourceRef };
    },
};
//# sourceMappingURL=persona_create.js.map