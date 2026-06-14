/*
 * Copyright 2026 Notboatanchor Labs LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
// src/tools/session_close.ts
// =============================================================================
// session_close tool handler (GIF-020)
// Explicitly closes a v0.2 governance session.
//
// Flow:
//   1. Persona is validated by the dispatcher before execute() is called.
//   2. Look up sessions row by gif_session_id.
//   3. Reject if not found, owned by a different persona, or already closed
//      (idempotent-by-rejection per GIF-020 — second close is not a no-op).
//   4. UPDATE sessions.ended_at = now().
//   5. INSERT a session_close audit event linked to the session_id.
//   6. Return { closed: true }.
//
// skipSession: true. The call does not itself require a session to be open;
// the handler operates on the caller-supplied gif_session_id directly.
//
// GIF-020: closure semantics
// GIF-022 C3.1–C3.5: conformance MUSTs for session_close
// =============================================================================
import pool from '../db.js';
import { logAuditEvent } from '../session.js';
// ----------------------------------------------------------------------------
// executeSessionClose()
// ----------------------------------------------------------------------------
export async function executeSessionClose(args, persona, _sessionId) {
    const { persona_id, gif_session_id } = args;
    // Look up the session row to validate ownership and current state.
    let rejection = null;
    let auditSessionId = null;
    try {
        const result = await pool.query(`SELECT persona_id, ended_at
       FROM sessions
       WHERE session_id = $1
       LIMIT 1`, [gif_session_id]);
        if (result.rows.length === 0) {
            rejection = 'SESSION_NOT_FOUND';
        }
        else {
            const row = result.rows[0];
            if (row.persona_id !== persona_id) {
                rejection = 'SESSION_PERSONA_MISMATCH';
                auditSessionId = gif_session_id;
            }
            else if (row.ended_at !== null) {
                rejection = 'SESSION_ALREADY_CLOSED';
                auditSessionId = gif_session_id;
            }
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[session_close] Lookup failed:`, message);
        return {
            content: [{ type: 'text', text: JSON.stringify({
                        error: 'Session lookup failed due to an internal error',
                    }) }],
            isError: true,
        };
    }
    if (rejection) {
        await logAuditEvent({
            personaId: persona_id,
            sessionId: auditSessionId,
            eventType: 'session_rejected_closed',
            toolName: 'session_close',
            outcome: 'denied',
            sourceRef: rejection,
            purposeDeclared: persona.purpose,
        });
        return {
            content: [{ type: 'text', text: JSON.stringify({
                        closed: false,
                        error: rejection,
                    }) }],
            isError: true,
        };
    }
    // C3.4: set ended_at AND emit session_close audit event. Both writes are
    // part of the successful-close commitment. The audit emission is
    // best-effort (audit-never-throws), but it is sequenced after the UPDATE
    // so the typical success path records both.
    try {
        await pool.query(`UPDATE sessions SET ended_at = now() WHERE session_id = $1`, [gif_session_id]);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[session_close] UPDATE failed for session ${gif_session_id}:`, message);
        return {
            content: [{ type: 'text', text: JSON.stringify({
                        error: 'Session close failed due to an internal error',
                    }) }],
            isError: true,
        };
    }
    await logAuditEvent({
        personaId: persona_id,
        sessionId: gif_session_id,
        eventType: 'session_close',
        toolName: 'session_close',
        outcome: 'allowed',
        purposeDeclared: persona.purpose,
    });
    return {
        content: [{ type: 'text', text: JSON.stringify({
                    closed: true,
                    gif_session_id,
                }) }],
    };
}
// ----------------------------------------------------------------------------
// ToolHandler export — consumed by the tool registry
// Framework tool: ships with GIF enforcement engine.
// skipSession: true — handler operates on a caller-supplied handle.
// ----------------------------------------------------------------------------
export const handler = {
    definition: {
        name: 'session_close',
        description: 'Explicitly close a v0.2 governance session. Validates persona ownership, sets sessions.ended_at, and emits a session_close audit event. Per GIF-020.',
        inputSchema: {
            type: 'object',
            properties: {
                persona_id: { type: 'string', format: 'uuid', description: 'UUID of the persona that owns the session' },
                gif_session_id: { type: 'string', format: 'uuid', description: 'Governance session handle to close (returned by session_start)' },
            },
            required: ['persona_id', 'gif_session_id'],
        },
    },
    execute: (args, persona, sessionId) => executeSessionClose({
        persona_id: args['persona_id'],
        gif_session_id: args['gif_session_id'],
    }, persona, sessionId),
    skipSession: true,
};
//# sourceMappingURL=session_close.js.map