"use strict";
// src/persona.ts
// =============================================================================
// Persona validation layer
// Every tool call passes through validatePersona() before any tool executes.
// Validates existence, active status, and temporal bounds against the
// personas table. Returns the full persona record on success so tool
// handlers can check scope without a second database round trip.
//
// Scope checking (permitted_actions, permitted_sources, output_destinations)
// is handled per-tool in the individual tool handlers — not here.
// This layer is responsible for: does this persona exist and is it valid to use.
// =============================================================================
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.validatePersona = validatePersona;
exports.logScopeViolation = logScopeViolation;
const db_js_1 = __importDefault(require("./db.js"));
// ----------------------------------------------------------------------------
// validatePersona()
// ----------------------------------------------------------------------------
async function validatePersona(personaId) {
    if (!personaId || typeof personaId !== 'string' || personaId.trim() === '') {
        return {
            valid: false,
            reason: 'NOT_FOUND',
            message: 'persona_id is required and must be a non-empty string',
        };
    }
    let persona;
    try {
        const result = await db_js_1.default.query(`SELECT
         persona_id,
         issuing_entity,
         purpose,
         created_by,
         scope_definition,
         valid_from,
         valid_until,
         parent_persona_id,
         max_delegation_depth,
         status,
         data_classification_ceiling,
         combination_policy_ref,
         governance_review_status,
         created_at,
         updated_at
       FROM personas
       WHERE persona_id = $1
       LIMIT 1`, [personaId]);
        if (result.rows.length === 0) {
            return {
                valid: false,
                reason: 'NOT_FOUND',
                message: `Persona ${personaId} not found`,
            };
        }
        persona = result.rows[0];
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown database error';
        console.error(`[persona] Database error validating persona ${personaId}:`, message);
        return {
            valid: false,
            reason: 'DB_ERROR',
            message: `Database error during persona validation: ${message}`,
        };
    }
    // Status check
    if (persona.status !== 'active') {
        return {
            valid: false,
            reason: 'NOT_ACTIVE',
            message: `Persona ${personaId} is not active (status: ${persona.status})`,
        };
    }
    const now = new Date();
    // Temporal check — valid_from
    if (persona.valid_from && persona.valid_from > now) {
        return {
            valid: false,
            reason: 'NOT_YET_VALID',
            message: `Persona ${personaId} is not yet valid (valid_from: ${persona.valid_from.toISOString()})`,
        };
    }
    // Temporal check — valid_until
    if (persona.valid_until && persona.valid_until < now) {
        return {
            valid: false,
            reason: 'EXPIRED',
            message: `Persona ${personaId} has expired (valid_until: ${persona.valid_until.toISOString()})`,
        };
    }
    return { valid: true, persona };
}
// ----------------------------------------------------------------------------
// logScopeViolation()
// Records an out-of-scope attempt in the scope_violations table.
// Schema: violation_id, persona_id, session_id, attempted_action,
//         attempted_tool, blocked_at, blocked, context_snapshot,
//         available_but_unused, occurred_at
//
// Does not throw — logging failure must not mask the rejection response.
// ----------------------------------------------------------------------------
async function logScopeViolation(params) {
    const { personaId, sessionId, attemptedAction, toolName, blockedAt, context } = params;
    try {
        await db_js_1.default.query(`INSERT INTO scope_violations (
         persona_id,
         session_id,
         attempted_action,
         attempted_tool,
         blocked_at,
         blocked,
         context_snapshot
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
            personaId,
            sessionId,
            attemptedAction,
            toolName,
            blockedAt,
            true,
            JSON.stringify(context),
        ]);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[persona] Failed to log scope violation for persona ${personaId}:`, message);
    }
}
//# sourceMappingURL=persona.js.map