"use strict";
// src/enforcement.ts
// =============================================================================
// GIF enforcement module — adopter import point (ADR-027 Stage 1)
//
// This file is the public API surface that adopters import to build their
// own MCP servers on top of GIF enforcement (ADR-026).
//
// Adopter usage pattern:
//   import { createEnforcement } from 'gif-enforcement';
//   import pool from './db.js';
//   export const { validatePersona, createSession, closeSession, logAuditEvent }
//     = createEnforcement(pool);
//
// The pool is injected by the adopter so that each MCP server runs under its
// own application credentials (gif_app, research_app, etc.) — ADR-028.
//
// GIF-MCP-server's own index.ts imports this module with the gif_app pool.
// Research Pipeline's enforcement.ts imports this module with the research_app pool.
//
// ADR-026: GIF enforcement as importable module; adopter builds the server
// ADR-027: Stage 1 — code-level extraction before physical repo split
// ADR-028: Per-adopter application credentials injected at construction time
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.createEnforcement = createEnforcement;
// ---------------------------------------------------------------------------
// createEnforcement()
// Factory that returns enforcement functions bound to the provided pool.
// Call once at MCP server startup with the application's DB pool.
// ---------------------------------------------------------------------------
function createEnforcement(pool) {
    return {
        validatePersona: (personaId) => _validatePersona(pool, personaId),
        createSession: (params) => _createSession(pool, params),
        closeSession: (sessionId) => _closeSession(pool, sessionId),
        logAuditEvent: (params) => _logAuditEvent(pool, params),
        logScopeViolation: (params) => _logScopeViolation(pool, params),
    };
}
// ---------------------------------------------------------------------------
// _validatePersona()
// ---------------------------------------------------------------------------
async function _validatePersona(pool, personaId) {
    if (!personaId || typeof personaId !== 'string' || personaId.trim() === '') {
        return {
            valid: false,
            reason: 'NOT_FOUND',
            message: 'persona_id is required and must be a non-empty string',
        };
    }
    let persona;
    try {
        const result = await pool.query(`SELECT
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
        console.error(`[gif-enforcement] DB error validating persona ${personaId}:`, message);
        return {
            valid: false,
            reason: 'DB_ERROR',
            message: `Database error during persona validation: ${message}`,
        };
    }
    if (persona.status !== 'active') {
        return {
            valid: false,
            reason: 'NOT_ACTIVE',
            message: `Persona ${personaId} is not active (status: ${persona.status})`,
        };
    }
    const now = new Date();
    if (persona.valid_from && persona.valid_from > now) {
        return {
            valid: false,
            reason: 'NOT_YET_VALID',
            message: `Persona ${personaId} is not yet valid (valid_from: ${persona.valid_from.toISOString()})`,
        };
    }
    if (persona.valid_until && persona.valid_until < now) {
        return {
            valid: false,
            reason: 'EXPIRED',
            message: `Persona ${personaId} has expired (valid_until: ${persona.valid_until.toISOString()})`,
        };
    }
    return { valid: true, persona };
}
// ---------------------------------------------------------------------------
// _createSession()
// ---------------------------------------------------------------------------
async function _createSession(pool, params) {
    const result = await pool.query(`INSERT INTO sessions (persona_id, invocation_context)
     VALUES ($1, $2)
     RETURNING session_id`, [params.personaId, JSON.stringify(params.invocationContext)]);
    return result.rows[0].session_id;
}
// ---------------------------------------------------------------------------
// _closeSession()
// Does not throw — a close failure must not mask the tool response.
// ---------------------------------------------------------------------------
async function _closeSession(pool, sessionId) {
    try {
        await pool.query(`UPDATE sessions SET ended_at = now() WHERE session_id = $1`, [sessionId]);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[gif-enforcement] Failed to close session ${sessionId}:`, message);
    }
}
// ---------------------------------------------------------------------------
// _logAuditEvent()
// Does not throw — audit failure must not mask the tool response.
// ---------------------------------------------------------------------------
async function _logAuditEvent(pool, params) {
    const { personaId, sessionId, eventType, toolName, outcome, sourceRef, sourcesActed = [], flagged = false, purposeDeclared, } = params;
    try {
        await pool.query(`INSERT INTO audit_events (
         persona_id,
         session_id,
         event_type,
         tool_name,
         outcome,
         source_ref,
         sources_touched,
         flagged,
         purpose_declared
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [
            personaId,
            sessionId,
            eventType,
            toolName,
            outcome,
            sourceRef ?? null,
            JSON.stringify(sourcesActed),
            flagged,
            purposeDeclared ?? null,
        ]);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[gif-enforcement] Failed to log audit event for session ${sessionId}:`, message);
    }
}
// ---------------------------------------------------------------------------
// _logScopeViolation()
// Does not throw — logging failure must not mask the rejection response.
// ---------------------------------------------------------------------------
async function _logScopeViolation(pool, params) {
    const { personaId, sessionId, attemptedAction, toolName, blockedAt, context } = params;
    try {
        await pool.query(`INSERT INTO scope_violations (
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
        console.error(`[gif-enforcement] Failed to log scope violation for persona ${personaId}:`, message);
    }
}
//# sourceMappingURL=enforcement.js.map