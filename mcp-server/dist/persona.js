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
// Primary entry point. Called by every tool handler before execution.
// ----------------------------------------------------------------------------
async function validatePersona(personaId) {
    // Guard against obviously invalid input before hitting the database.
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
    // Status check — must be active.
    // Suspended, revoked, and expired are all distinct failure modes
    // but all result in rejection at this layer.
    if (persona.status !== 'active') {
        return {
            valid: false,
            reason: 'NOT_ACTIVE',
            message: `Persona ${personaId} is not active (status: ${persona.status})`,
        };
    }
    const now = new Date();
    // Temporal check — valid_from.
    // Persona record exists but activation window has not started.
    if (persona.valid_from && persona.valid_from > now) {
        return {
            valid: false,
            reason: 'NOT_YET_VALID',
            message: `Persona ${personaId} is not yet valid (valid_from: ${persona.valid_from.toISOString()})`,
        };
    }
    // Temporal check — valid_until.
    // Null valid_until means no expiry declared — permitted by schema.
    if (persona.valid_until && persona.valid_until < now) {
        return {
            valid: false,
            reason: 'EXPIRED',
            message: `Persona ${personaId} has expired (valid_until: ${persona.valid_until.toISOString()})`,
        };
    }
    // All checks passed.
    return { valid: true, persona };
}
// ----------------------------------------------------------------------------
// logScopeViolation()
// Called by tool handlers when a valid persona attempts an action outside
// its declared scope. Persona existence is already confirmed at this point.
// Records the violation in scope_violations for audit purposes.
// Does not throw — a logging failure must not mask the rejection response.
// ----------------------------------------------------------------------------
async function logScopeViolation(params) {
    const { personaId, attemptedAction, toolName, context } = params;
    try {
        await db_js_1.default.query(`INSERT INTO scope_violations (
         persona_id,
         attempted_action,
         blocked_at,
         context_snapshot
       ) VALUES ($1, $2, now(), $3)`, [
            personaId,
            `${toolName}:${attemptedAction}`,
            JSON.stringify(context),
        ]);
    }
    catch (err) {
        // Log but do not throw — violation logging failure must not prevent
        // the rejection response from reaching the caller.
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[persona] Failed to log scope violation for persona ${personaId}:`, message);
    }
}
//# sourceMappingURL=persona.js.map