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
const crypto_1 = require("crypto");
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
        verifyIdentityBinding: (params) => _verifyIdentityBinding(pool, params),
        logAuditRead: (params) => _logAuditRead(pool, params),
        // -----------------------------------------------------------------------
        // checkCombinationPolicies()
        // Call before tool execution when a tool declares source refs.
        // Builds candidate set = {session sources so far} ∪ {incomingSourceRefs},
        // then evaluates all active combination policies (ADR-023).
        //
        // Returns:
        //   { triggered: false }                   — no policy fires, proceed
        //   { triggered: true, exempt: true, ... } — policy fires but persona is
        //                                            exempt; proceed with flagged
        //                                            audit event
        //   { triggered: true, exempt: false, ... } — policy fires; apply
        //                                             enforcementAction (block, etc.)
        //
        // Does NOT throw. Fails-closed on DB error (returns a synthetic blocked
        // result) so a broken policy table does not silently allow combinations.
        // -----------------------------------------------------------------------
        checkCombinationPolicies: (params) => _checkCombinationPolicies(pool, params),
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
    if (persona.valid_from > now) {
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
    if (persona.governance_review_status !== 'approved') {
        return {
            valid: false,
            reason: 'GOVERNANCE_REVIEW_REQUIRED',
            message: `Persona ${personaId} is not approved for use (governance_review_status: ${persona.governance_review_status})`,
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
    const { personaId, sessionId, eventType, toolName, outcome, sourceRef, sourcesActed = [], flagged = false, humanActorId, purposeDeclared, } = params;
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
         human_actor_id,
         purpose_declared
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [
            personaId,
            sessionId,
            eventType,
            toolName,
            outcome,
            sourceRef ?? null,
            JSON.stringify(sourcesActed),
            flagged,
            humanActorId ?? null,
            purposeDeclared ?? null,
        ]);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[gif-enforcement] Failed to log audit event for session ${sessionId}:`, message);
    }
}
// ---------------------------------------------------------------------------
// _verifyIdentityBinding()
// Verifies an HMAC-SHA-256 signed identity token and consumes it.
//
// Token format: base64url(JSON payload) + "." + hmac_hex
// Payload: { assignment_id: string, issued_at: ISO8601 }
//
// Steps:
//   1. Parse and HMAC-verify the token (timing-safe comparison)
//   2. Validate token age (reject if older than 15 minutes)
//   3. Look up the assignment in user_persona_assignments
//   4. Consume the token (one-way UPDATE: token_consumed false → true)
//
// Throws nothing — returns IdentityBindingResult.
// Token consumption happens atomically in a single UPDATE with the
// token_consumed = false WHERE clause (optimistic concurrency).
// ---------------------------------------------------------------------------
async function _verifyIdentityBinding(pool, params) {
    const { identityToken } = params;
    // Step 1: Parse token structure
    const dotIndex = identityToken.lastIndexOf('.');
    if (dotIndex === -1) {
        return { valid: false, reason: 'Malformed token: missing signature delimiter' };
    }
    const payloadB64 = identityToken.slice(0, dotIndex);
    const providedHmac = identityToken.slice(dotIndex + 1);
    if (!payloadB64 || !providedHmac) {
        return { valid: false, reason: 'Malformed token: empty payload or signature' };
    }
    // Step 2: Verify HMAC
    const secret = process.env['IDENTITY_HMAC_SECRET'];
    if (!secret) {
        console.error('[gif-enforcement] IDENTITY_HMAC_SECRET is not set — identity binding unavailable');
        return { valid: false, reason: 'IDENTITY_HMAC_SECRET not configured on server' };
    }
    const expectedHmac = (0, crypto_1.createHmac)('sha256', secret).update(payloadB64).digest('hex');
    // Pad to equal length for timingSafeEqual
    const expectedBuf = Buffer.from(expectedHmac, 'hex');
    const providedBuf = Buffer.from(providedHmac.padEnd(expectedHmac.length, '0'), 'hex');
    if (expectedBuf.length !== providedBuf.length || !(0, crypto_1.timingSafeEqual)(expectedBuf, providedBuf)) {
        return { valid: false, reason: 'Invalid token signature' };
    }
    // Step 3: Decode and validate payload
    let payload;
    try {
        payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    }
    catch {
        return { valid: false, reason: 'Malformed token payload' };
    }
    if (!payload.assignment_id || !payload.issued_at) {
        return { valid: false, reason: 'Token missing required fields (assignment_id, issued_at)' };
    }
    // Validate token age — 15-minute window
    const issuedAt = new Date(payload.issued_at);
    if (isNaN(issuedAt.getTime())) {
        return { valid: false, reason: 'Token issued_at is not a valid timestamp' };
    }
    const ageMs = Date.now() - issuedAt.getTime();
    if (ageMs > 15 * 60 * 1000) {
        return { valid: false, reason: 'Token expired (older than 15 minutes)' };
    }
    // Step 4: Look up assignment and consume token
    try {
        const lookup = await pool.query(`SELECT assignment_id, external_user_id
       FROM user_persona_assignments
       WHERE assignment_id  = $1
         AND token_consumed = false
         AND revoked_at     IS NULL
       LIMIT 1`, [payload.assignment_id]);
        if (lookup.rows.length === 0) {
            return { valid: false, reason: 'Assignment not found, already consumed, or revoked' };
        }
        const { assignment_id, external_user_id } = lookup.rows[0];
        // Consume: one-way false → true. WHERE token_consumed = false ensures
        // idempotency — concurrent calls for the same token only one succeeds.
        const consumed = await pool.query(`UPDATE user_persona_assignments
       SET token_consumed    = true,
           token_consumed_at = now()
       WHERE assignment_id  = $1
         AND token_consumed = false`, [assignment_id]);
        if (consumed.rowCount === 0) {
            // Lost race with another concurrent call — token consumed between lookup and update
            return { valid: false, reason: 'Assignment not found, already consumed, or revoked' };
        }
        return { valid: true, assignmentId: assignment_id, externalUserId: external_user_id };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error('[gif-enforcement] verifyIdentityBinding DB error:', message);
        return { valid: false, reason: `Database error during identity binding: ${message}` };
    }
}
// ---------------------------------------------------------------------------
// _logAuditRead()
// Records every db_read call against an audit-class table.
// Does not throw — logging failure must not mask the read response.
// ---------------------------------------------------------------------------
async function _logAuditRead(pool, params) {
    try {
        await pool.query(`INSERT INTO audit_read_log (
         reader_persona_id,
         reader_session_id,
         queried_table,
         partition_hint,
         filters_applied,
         rows_returned,
         purpose_declared
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
            params.readerPersonaId,
            params.readerSessionId,
            params.queriedTable,
            params.partitionHint ?? null,
            params.filtersApplied ? JSON.stringify(params.filtersApplied) : null,
            params.rowsReturned,
            params.purposeDeclared ?? null,
        ]);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[gif-enforcement] Failed to log audit read for persona ${params.readerPersonaId}:`, message);
    }
}
// ---------------------------------------------------------------------------
// _checkCombinationPolicies()
// Pre-execution aggregation risk check (ADR-023).
//
// Builds candidate set = {sources already touched this session} ∪ {incomingSourceRefs}.
// If any active policy's source_set ⊆ candidate set, the policy fires.
//
// Does NOT throw. Fails-closed on DB error — a broken policy table must not
// silently allow sensitive combinations through.
// ---------------------------------------------------------------------------
async function _checkCombinationPolicies(pool, params) {
    const { sessionId, personaId, incomingSourceRefs } = params;
    // No sources declared — nothing to check
    if (incomingSourceRefs.length === 0) {
        return { triggered: false };
    }
    // No session — skip (persona_validate and other skipSession tools)
    if (!sessionId) {
        return { triggered: false };
    }
    try {
        // Step 1: Accumulate sources already touched in this session
        const sessionResult = await pool.query(`SELECT array_agg(DISTINCT elem) AS sources
         FROM gif.audit_events ae,
              jsonb_array_elements_text(ae.sources_touched) elem
        WHERE ae.session_id = $1
          AND ae.persona_id = $2
          AND ae.sources_touched IS NOT NULL
          AND jsonb_array_length(ae.sources_touched) > 0`, [sessionId, personaId]);
        const sessionSources = new Set(sessionResult.rows[0]?.sources ?? []);
        // Step 2: Add incoming sources to form the candidate set
        for (const s of incomingSourceRefs) {
            sessionSources.add(s);
        }
        // Step 3: Load active policies
        const policiesResult = await pool.query(`SELECT policy_id, policy_name, source_set, sensitivity_result,
              enforcement_action, exempt_persona_ids
         FROM gif.combination_policies
        WHERE active = true`);
        // Step 4: Evaluate each policy — fire on first match
        for (const policy of policiesResult.rows) {
            const policySet = policy.source_set;
            const allPresent = policySet.every(s => sessionSources.has(s));
            if (!allPresent)
                continue;
            const exempt = policy.exempt_persona_ids.includes(personaId);
            return {
                triggered: true,
                policyId: policy.policy_id,
                policyName: policy.policy_name,
                enforcementAction: policy.enforcement_action,
                sensitivityResult: policy.sensitivity_result,
                exempt,
            };
        }
        return { triggered: false };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error('[gif-enforcement] Combination policy check failed — failing closed:', message);
        // Fail-closed: return a synthetic block result so a DB error does not
        // silently allow a sensitive combination through.
        return {
            triggered: true,
            policyId: 'error',
            policyName: 'policy-check-error',
            enforcementAction: 'block',
            sensitivityResult: 'restricted',
            exempt: false,
        };
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