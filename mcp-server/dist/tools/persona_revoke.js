"use strict";
// src/tools/persona_revoke.ts
// =============================================================================
// persona_revoke tool handler
// Revokes a persona by setting status='revoked' and writing to revocation_log.
//
// Scope checks:
//   - Issuing persona must have 'manage_personas' in permitted_actions.
//
// Revocation is immediate. Active sessions under the target persona are NOT
// force-closed by this tool — they will fail persona validation on next call.
// The revocation_log.active_sessions_terminated field is set to 0; a future
// session sweep (Sprint 4) will populate this accurately.
//
// The target persona_id is captured in source_ref on the audit event, making
// persona_revoke events first-class and reconstructible without joining
// revocation_log.
//
// ADR-008: MCP server as the AI tool interface layer
// ADR-009: Persona-based permissions as infrastructure
// ADR-017: Governance audit schema stubs
// =============================================================================
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.executePersonaRevoke = executePersonaRevoke;
const db_js_1 = __importDefault(require("../db.js"));
const persona_js_1 = require("../persona.js");
// ----------------------------------------------------------------------------
// executePersonaRevoke()
// ----------------------------------------------------------------------------
async function executePersonaRevoke(args, persona, sessionId) {
    // Scope check — issuer must have manage_personas
    const scope = persona.scope_definition;
    if (!scope.permitted_actions || !scope.permitted_actions.includes('manage_personas')) {
        await (0, persona_js_1.logScopeViolation)({
            personaId: args.persona_id,
            sessionId,
            attemptedAction: 'manage_personas',
            toolName: 'persona_revoke',
            blockedAt: 'mcp_validation',
            context: { target_persona_id: args.target_persona_id },
        });
        return {
            content: [{ type: 'text', text: JSON.stringify({
                        error: `Persona ${args.persona_id} does not have 'manage_personas' in permitted_actions`,
                    }) }],
            isError: true,
        };
    }
    // Fetch target persona to record previous status
    let previousStatus;
    try {
        const targetResult = await db_js_1.default.query(`SELECT status FROM personas WHERE persona_id = $1 LIMIT 1`, [args.target_persona_id]);
        if (targetResult.rows.length === 0) {
            return {
                content: [{ type: 'text', text: JSON.stringify({
                            error: `Target persona ${args.target_persona_id} not found`,
                        }) }],
                isError: true,
            };
        }
        previousStatus = targetResult.rows[0].status;
        if (previousStatus === 'revoked') {
            return {
                content: [{ type: 'text', text: JSON.stringify({
                            error: `Persona ${args.target_persona_id} is already revoked`,
                        }) }],
                isError: true,
            };
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[persona_revoke] Failed to fetch target persona:`, message);
        return {
            content: [{ type: 'text', text: JSON.stringify({ error: `Revocation failed: ${message}` }) }],
            isError: true,
        };
    }
    // Execute revocation in a transaction — status update + revocation_log are atomic
    try {
        await db_js_1.default.query('BEGIN');
        await db_js_1.default.query(`UPDATE personas
       SET status = 'revoked', updated_at = now()
       WHERE persona_id = $1`, [args.target_persona_id]);
        await db_js_1.default.query(`INSERT INTO revocation_log (
         persona_id,
         previous_status,
         new_status,
         reason,
         revoked_by,
         active_sessions_terminated
       ) VALUES ($1, $2, 'revoked', $3, $4, 0)`, [
            args.target_persona_id,
            previousStatus,
            args.reason,
            args.revoked_by,
        ]);
        await db_js_1.default.query('COMMIT');
        return {
            content: [{ type: 'text', text: JSON.stringify({
                        target_persona_id: args.target_persona_id,
                        previous_status: previousStatus,
                        new_status: 'revoked',
                        reason: args.reason,
                        revoked_by: args.revoked_by,
                        revoked: true,
                    }) }],
        };
    }
    catch (err) {
        await db_js_1.default.query('ROLLBACK');
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[persona_revoke] Transaction failed:`, message);
        return {
            content: [{ type: 'text', text: JSON.stringify({ error: `Revocation failed: ${message}` }) }],
            isError: true,
        };
    }
}
//# sourceMappingURL=persona_revoke.js.map