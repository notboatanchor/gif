"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
exports.executeSessionStart = executeSessionStart;
// src/tools/session_start.ts
// =============================================================================
// session_start tool handler (GIF-019)
// Mints a v0.2 governance session handle (gif_session_id).
//
// Flow:
//   1. Persona is validated by the dispatcher before execute() is called.
//   2. INSERT a row into gif.sessions with the asserted persona_id and
//      caller-supplied invocation_context (optional).
//   3. INSERT a session_start audit event linked to the new session_id.
//   4. Return { gif_session_id } in the response.
//
// skipSession: true. The dispatcher does not mint a per-call session for
// session_start; this handler mints the long-lived governance session that
// subsequent governed calls will thread through their gif_session_id arg.
//
// GIF-019: handle mint point and propagation channel
// GIF-022 C1.1–C1.6: conformance MUSTs for session_start
// =============================================================================
const session_js_1 = require("../session.js");
// ----------------------------------------------------------------------------
// executeSessionStart()
// ----------------------------------------------------------------------------
async function executeSessionStart(args, persona, _sessionId) {
    const invocationContext = {
        minted_by: 'session_start',
        persona_purpose: persona.purpose,
        persona_valid_until: persona.valid_until,
        ...(args.invocation_context ?? {}),
    };
    const newSessionId = await (0, session_js_1.createSession)({
        personaId: args.persona_id,
        invocationContext,
    });
    // C1.5: exactly one session_start audit event linked to the new session_id.
    // Best-effort per audit-never-throws — logAuditEvent catches internally.
    await (0, session_js_1.logAuditEvent)({
        personaId: args.persona_id,
        sessionId: newSessionId,
        eventType: 'session_start',
        toolName: 'session_start',
        outcome: 'success',
        purposeDeclared: persona.purpose,
    });
    return {
        content: [{ type: 'text', text: JSON.stringify({
                    gif_session_id: newSessionId,
                }) }],
    };
}
// ----------------------------------------------------------------------------
// ToolHandler export — consumed by the tool registry
// Framework tool: ships with GIF enforcement engine.
// skipSession: true — handler mints its own governance session.
// ----------------------------------------------------------------------------
exports.handler = {
    definition: {
        name: 'session_start',
        description: 'Mint a v0.2 governance session handle (gif_session_id). Returns the handle that subsequent governed tool calls must include in their args. Per GIF-019.',
        inputSchema: {
            type: 'object',
            properties: {
                persona_id: { type: 'string', format: 'uuid', description: 'UUID of the persona under which this session is opened' },
                invocation_context: { type: 'object', description: 'Optional adopter-supplied free-form metadata captured at session start (e.g., {"workflow": "intake"})' },
            },
            required: ['persona_id'],
        },
    },
    execute: (args, persona, sessionId) => executeSessionStart({
        persona_id: args['persona_id'],
        invocation_context: args['invocation_context'],
    }, persona, sessionId),
    skipSession: true,
};
//# sourceMappingURL=session_start.js.map