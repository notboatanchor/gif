"use strict";
// src/session.ts
// =============================================================================
// Session management
// Creates and closes session records in the sessions table.
// Every tool call creates a session. The session_id is passed to audit
// event and scope violation logging throughout the tool call lifecycle.
//
// Sessions are persona-scoped. A session record is the temporal container
// for all audit events within a single tool invocation.
//
// ADR-017: Governance audit schema stubs
// =============================================================================
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSession = createSession;
exports.closeSession = closeSession;
exports.logAuditEvent = logAuditEvent;
const db_js_1 = __importDefault(require("./db.js"));
// ----------------------------------------------------------------------------
// createSession()
// Called at the start of every tool invocation after persona validation.
// invocation_context captures the tool name and arguments at call time —
// supports point-in-time reconstruction per ADR-017.
// ----------------------------------------------------------------------------
async function createSession(params) {
    const { personaId, invocationContext } = params;
    try {
        const result = await db_js_1.default.query(`INSERT INTO sessions (persona_id, invocation_context)
       VALUES ($1, $2)
       RETURNING session_id`, [personaId, JSON.stringify(invocationContext)]);
        return result.rows[0].session_id;
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[session] Failed to create session for persona ${personaId}:`, message);
        throw new Error(`Session creation failed: ${message}`);
    }
}
// ----------------------------------------------------------------------------
// closeSession()
// Called when a tool invocation completes — success or failure.
// Does not throw — a close failure must not mask the tool response.
// ----------------------------------------------------------------------------
async function closeSession(sessionId) {
    try {
        await db_js_1.default.query(`UPDATE sessions SET ended_at = now() WHERE session_id = $1`, [sessionId]);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[session] Failed to close session ${sessionId}:`, message);
    }
}
// ----------------------------------------------------------------------------
// logAuditEvent()
// Records a tool execution event in the audit_events table.
// Called after every tool call — successful or not.
// Does not throw — audit logging failure must not mask the tool response.
// ----------------------------------------------------------------------------
async function logAuditEvent(params) {
    const { personaId, sessionId, eventType, toolName, outcome, sourcesActed = [], flagged = false, purposeDeclared, } = params;
    try {
        await db_js_1.default.query(`INSERT INTO audit_events (
         persona_id,
         session_id,
         event_type,
         tool_name,
         outcome,
         sources_touched,
         flagged,
         purpose_declared
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
            personaId,
            sessionId,
            eventType,
            toolName,
            outcome,
            JSON.stringify(sourcesActed),
            flagged,
            purposeDeclared ?? null,
        ]);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[session] Failed to log audit event for session ${sessionId}:`, message);
    }
}
//# sourceMappingURL=session.js.map