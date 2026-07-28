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
// src/index.ts
// =============================================================================
// GIF MCP server — entry point
// Hosted via the SDK's createMcpHandler (2026-07-28 revision): modern
// requests are served per-request (server/discover + _meta envelope handled
// by the SDK); 2025-era requests are served by the SDK's built-in stateless
// Streamable HTTP fallback (ADR-002). Listens on PORT (default 3100).
//
// Dispatcher responsibilities (v0.2 — GIF-019/020/022):
//   1. Validate persona (existence, active status, temporal bounds, governance).
//   2. For skipSession tools (persona_validate, session_start, session_close):
//      dispatch directly with no session validation.
//   3. For governed tools: validate the caller-supplied gif_session_id —
//      ownership, closed (closure precedence), expired (TTL).
//   4. On session rejection: emit best-effort audit (session_rejected_closed
//      for closed/missing/mismatch, session_expired for TTL) and return an
//      error response.
//   5. On accept: dispatch to the tool handler with the validated session_id.
//   6. Log the post-execution audit event linked to that session_id.
//   7. Do NOT close the session — closure is caller-driven (session_close)
//      or TTL-driven, per GIF-020.
//
// Tools are registered in src/tools/registry.ts (ADR-026, ADR-027). The
// dispatcher has no knowledge of which tools exist or what they do.
//
// ADR-002: Streamable HTTP transport (replaces deprecated SSE transport)
// ADR-008: MCP server as the AI tool interface layer
// ADR-009: Persona-based permissions as infrastructure
// ADR-017: Governance audit schema stubs
// ADR-019: MCP server language, runtime, and port assignment
// ADR-026: MCP server deployment topology
// ADR-027: GIF packaging model and extraction progression
// GIF-019: Session handle mint and propagation (gif_session_id as tool arg)
// GIF-020: Session closure semantics (caller-close + hard TTL)
// GIF-022: v0.2 conformance surface
// =============================================================================
import { Server, ProtocolError, ProtocolErrorCode, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import http from 'http';
import { validatePersona } from './persona.js';
import { logAuditEvent, validateSessionHandle } from './session.js';
import { TOOL_REGISTRY } from './tools/registry.js';
import { findMissingRequiredArg } from './tools/arg-guards.js';
const PORT = parseInt(process.env.PORT || '3100');
// GIF_SESSION_TTL_SECONDS — deployment-wide hard TTL for governance sessions
// (GIF-020). Read once at startup. Default 86400 (24 hours).
const GIF_SESSION_TTL_SECONDS = parseInt(process.env.GIF_SESSION_TTL_SECONDS ?? '86400', 10);
if (!Number.isFinite(GIF_SESSION_TTL_SECONDS) || GIF_SESSION_TTL_SECONDS <= 0) {
    throw new Error(`GIF_SESSION_TTL_SECONDS must be a positive integer; got ${process.env.GIF_SESSION_TTL_SECONDS ?? '<unset>'}`);
}
// ----------------------------------------------------------------------------
// MCP server factory — one Server instance per request
// (Server is the low-level API required for registry-driven dispatch — gif's
// enforcement engine needs full control over request handling, which the
// high-level McpServer abstraction does not expose.)
// ----------------------------------------------------------------------------
function createServer() {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- low-level API required for registry-driven dispatch
    const server = new Server({ name: 'gif-mcp-server', version: '0.2.0' }, {
        capabilities: { tools: {} },
        // 2026-07-28 cache envelope: explicit do-not-cache hints. tools/list is
        // persona-independent today but the registry is enforcement surface —
        // never let a shared cache serve it; server/discover likewise. These
        // match the SDK defaults (ttlMs: 0, cacheScope: 'private') but the
        // posture is declared, not inherited.
        cacheHints: {
            'tools/list': { cacheScope: 'private', ttlMs: 0 },
            'server/discover': { cacheScope: 'private', ttlMs: 0 },
        },
    });
    // --------------------------------------------------------------------------
    // ListTools — derived from registry, no hardcoded definitions
    // --------------------------------------------------------------------------
    server.setRequestHandler('tools/list', () => ({
        tools: Array.from(TOOL_REGISTRY.values()).map(h => h.definition),
    }));
    // --------------------------------------------------------------------------
    // CallTool — enforcement engine + registry dispatch
    // Session lifecycle managed here — wraps all tool executions.
    // --------------------------------------------------------------------------
    server.setRequestHandler('tools/call', async (request) => {
        const { name, arguments: args } = request.params;
        if (!args || typeof args !== 'object') {
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Tool arguments are required');
        }
        const persona_id = args['persona_id'];
        if (!persona_id) {
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'persona_id is required for all tool calls');
        }
        const toolHandler = TOOL_REGISTRY.get(name);
        if (!toolHandler) {
            throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
        // Validate persona — always, regardless of skipSession
        const validation = await validatePersona(persona_id);
        if (!validation.valid) {
            return {
                content: [{ type: 'text', text: JSON.stringify({ valid: false, reason: validation.reason, message: validation.message }) }],
                isError: true,
            };
        }
        // The low-level Server performs no JSON-Schema validation of tool
        // inputSchemas — enforce `required` presence for every registered tool
        // here, so no handler depends on DB constraints to catch a missing
        // argument. Protocol-level InvalidParams with no audit, matching the
        // C2.2 treatment of a missing gif_session_id. persona_id (above) and
        // gif_session_id (below, and in-handler for session_close) keep their
        // dedicated checks.
        const missingArg = findMissingRequiredArg(toolHandler.definition.inputSchema.required, args);
        if (missingArg !== null) {
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, `${missingArg} is required for ${name}`);
        }
        // skipSession tools (persona_validate, session_start, session_close) —
        // execute directly. Session validation does not apply: session_start mints
        // its own handle, session_close operates on a caller-supplied handle, and
        // persona_validate produces no audit events.
        if (toolHandler.skipSession) {
            return toolHandler.execute(args, validation.persona, '');
        }
        // Governed tools — validate the caller-supplied gif_session_id (GIF-020).
        const gif_session_id = args['gif_session_id'];
        if (!gif_session_id) {
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'gif_session_id is required for governed tools — call session_start first');
        }
        const sessionCheck = await validateSessionHandle({
            personaId: persona_id,
            gifSessionId: gif_session_id,
            ttlSeconds: GIF_SESSION_TTL_SECONDS,
        });
        if (!sessionCheck.valid) {
            // GIF-020 audit-event mapping:
            //   SESSION_EXPIRED       → session_expired
            //   everything else       → session_rejected_closed (source_ref distinguishes)
            // Audit emission is best-effort (audit-never-throws). DB_ERROR skips the
            // audit — we don't know the session state, so we don't claim it.
            if (sessionCheck.reason !== 'SESSION_DB_ERROR') {
                const eventType = sessionCheck.reason === 'SESSION_EXPIRED'
                    ? 'session_expired'
                    : 'session_rejected_closed';
                await logAuditEvent({
                    personaId: persona_id,
                    sessionId: sessionCheck.auditSessionId,
                    eventType,
                    toolName: name,
                    outcome: 'denied',
                    sourceRef: sessionCheck.reason,
                    purposeDeclared: validation.persona.purpose,
                });
            }
            return {
                content: [{ type: 'text', text: JSON.stringify({
                            valid: false,
                            reason: sessionCheck.reason,
                            message: sessionCheck.message,
                        }) }],
                isError: true,
            };
        }
        const sessionId = sessionCheck.sessionId;
        let result;
        try {
            result = await toolHandler.execute(args, validation.persona, sessionId);
        }
        finally {
            // Resolve audit event type and source_ref.
            // Tools with auditMetadata control their own event classification.
            // All others emit a generic tool_call event.
            let eventType = 'tool_call';
            let sourceRef;
            let humanActorId;
            if (toolHandler.auditMetadata && result !== undefined) {
                const meta = toolHandler.auditMetadata(args, result);
                eventType = meta.eventType;
                sourceRef = meta.sourceRef;
                humanActorId = meta.humanActorId;
            }
            await logAuditEvent({
                personaId: persona_id,
                sessionId,
                eventType,
                toolName: name,
                outcome: result === undefined || result.isError ? 'error' : 'allowed',
                sourceRef,
                humanActorId,
                purposeDeclared: validation.persona.purpose,
            });
            // Session is NOT closed here (GIF-020). Closure is caller-driven via
            // session_close or TTL-driven via lazy expiry on the next call.
        }
        return result;
    });
    return server;
}
// ----------------------------------------------------------------------------
// MCP hosting — SDK createMcpHandler (2026-07-28 revision)
// The factory mints a fresh Server per request; server/discover and the
// _meta envelope are handled inside the SDK. 2025-era requests fall through
// the SDK's built-in stateless fallback (sessionIdGenerator: undefined;
// GET/DELETE answered 405). gif holds no transport-session state — persona
// and governance-session identity ride in tool args (persona_id,
// gif_session_id, GIF-019) — so per-request hosting drops no semantics.
// ----------------------------------------------------------------------------
const mcpHandler = createMcpHandler(() => createServer(), {
    // subscriptions/listen is served by the SDK BEFORE the factory's Server (and
    // therefore gif's enforcement core) is consulted — an unauthenticated caller
    // could otherwise hold open up to the SDK-default 1024 SSE streams. gif uses
    // no server-push subscriptions; refuse them all. Re-enabling requires an
    // authenticated subscription design, not just raising this cap.
    maxSubscriptions: 0,
    onerror: (err) => { console.error('[server] MCP handler error:', err.message); },
});
const mcpNodeHandler = toNodeHandler(mcpHandler, {
    onerror: (err) => { console.error('[server] MCP adapter error:', err.message); },
});
// ----------------------------------------------------------------------------
// HTTP server — thin router: /health stays hand-served (independently
// reverse-proxied in deployments — see
// docs/runbooks/adopter/production-deployment.md), /mcp delegates to the SDK
// handler. Host/Origin (DNS-rebinding) validation is deliberately not done
// here: gif deploys behind a reverse proxy that owns hostname routing (same
// runbook). Deployments that bind gif directly to a local port should put the
// SDK's hostHeaderValidationResponse / originValidationResponse helpers in
// front of the /mcp delegation.
// ----------------------------------------------------------------------------
const httpServer = http.createServer((req, res) => {
    console.log(`[server] ${req.method ?? ''} ${req.url ?? ''}`);
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'gif-mcp-server' }));
        return;
    }
    if (req.url === '/mcp') {
        mcpNodeHandler(req, res).catch((err) => {
            console.error('[server] Unhandled request error:', err);
            if (!res.headersSent) {
                res.writeHead(500);
                res.end();
            }
        });
        return;
    }
    res.writeHead(404);
    res.end();
});
httpServer.listen(PORT, () => {
    console.log(`[server] GIF MCP server running on port ${String(PORT)}`);
    console.log(`[server] Health: http://localhost:${String(PORT)}/health`);
    console.log(`[server] MCP:    http://localhost:${String(PORT)}/mcp`);
    console.log(`[server] Tools registered: ${Array.from(TOOL_REGISTRY.keys()).join(', ')}`);
    console.log(`[server] GIF_SESSION_TTL_SECONDS=${String(GIF_SESSION_TTL_SECONDS)}`);
});
process.on('SIGTERM', () => {
    console.log('[server] SIGTERM received — shutting down');
    mcpHandler.close().catch((err) => {
        console.error('[server] Error closing MCP handler:', err);
    });
    httpServer.close(() => {
        console.log('[server] HTTP server closed');
        process.exit(0);
    });
});
//# sourceMappingURL=index.js.map