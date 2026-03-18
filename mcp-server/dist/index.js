"use strict";
// src/index.ts
// =============================================================================
// GIF MCP server — entry point
// HTTP/SSE transport. Listens on PORT (default 3100).
//
// Enforcement engine responsibilities:
//   1. Validate persona (existence, active status, temporal bounds)
//   2. Create session record (unless tool.skipSession is true)
//   3. Dispatch to tool handler via TOOL_REGISTRY
//   4. Log audit event
//   5. Close session
//
// The enforcement engine has no knowledge of which tools exist or what they do.
// Tools are registered in src/tools/registry.ts (ADR-026, ADR-027).
//
// ADR-008: MCP server as the AI tool interface layer
// ADR-009: Persona-based permissions as infrastructure
// ADR-017: Governance audit schema stubs
// ADR-019: MCP server language, runtime, and port assignment
// ADR-026: MCP server deployment topology
// ADR-027: GIF packaging model and extraction progression
// =============================================================================
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const sse_js_1 = require("@modelcontextprotocol/sdk/server/sse.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const http_1 = __importDefault(require("http"));
const persona_js_1 = require("./persona.js");
const session_js_1 = require("./session.js");
const registry_js_1 = require("./tools/registry.js");
const PORT = parseInt(process.env.PORT || '3100');
// ----------------------------------------------------------------------------
// MCP server instance
// ----------------------------------------------------------------------------
const server = new index_js_1.Server({ name: 'gif-mcp-server', version: '0.1.0' }, { capabilities: { tools: {} } });
// ----------------------------------------------------------------------------
// Active SSE transports — keyed by sessionId
// ----------------------------------------------------------------------------
const transports = new Map();
// ----------------------------------------------------------------------------
// ListTools — derived from registry, no hardcoded definitions
// ----------------------------------------------------------------------------
server.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => ({
    tools: Array.from(registry_js_1.TOOL_REGISTRY.values()).map(h => h.definition),
}));
// ----------------------------------------------------------------------------
// CallTool — enforcement engine + registry dispatch
// Session lifecycle managed here — wraps all tool executions.
// ----------------------------------------------------------------------------
server.setRequestHandler(types_js_1.CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (!args || typeof args !== 'object') {
        throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, 'Tool arguments are required');
    }
    const persona_id = args['persona_id'];
    if (!persona_id) {
        throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, 'persona_id is required for all tool calls');
    }
    const toolHandler = registry_js_1.TOOL_REGISTRY.get(name);
    if (!toolHandler) {
        throw new types_js_1.McpError(types_js_1.ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    // Validate persona — always, regardless of skipSession
    const validation = await (0, persona_js_1.validatePersona)(persona_id);
    if (!validation.valid) {
        return {
            content: [{ type: 'text', text: JSON.stringify({ valid: false, reason: validation.reason, message: validation.message }) }],
            isError: true,
        };
    }
    // skipSession tools (persona_validate) — execute directly, no session or audit
    if (toolHandler.skipSession) {
        return toolHandler.execute(args, validation.persona, '');
    }
    // All other tools — create session, execute, audit, close session
    const sessionId = await (0, session_js_1.createSession)({
        personaId: persona_id,
        invocationContext: {
            tool: name,
            arguments: args,
            persona_purpose: validation.persona.purpose,
            persona_valid_until: validation.persona.valid_until,
        },
    });
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
        if (toolHandler.auditMetadata && result !== undefined) {
            const meta = toolHandler.auditMetadata(args, result);
            eventType = meta.eventType;
            sourceRef = meta.sourceRef;
        }
        await (0, session_js_1.logAuditEvent)({
            personaId: persona_id,
            sessionId,
            eventType,
            toolName: name,
            outcome: result === undefined || result.isError ? 'error' : 'success',
            sourceRef,
            purposeDeclared: validation.persona.purpose,
        });
        await (0, session_js_1.closeSession)(sessionId);
    }
    return result;
});
// ----------------------------------------------------------------------------
// HTTP server and SSE transport
// ----------------------------------------------------------------------------
const httpServer = http_1.default.createServer(async (req, res) => {
    console.log(`[server] ${req.method} ${req.url}`);
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'gif-mcp-server' }));
        return;
    }
    if (req.method === 'GET' && req.url === '/sse') {
        const transport = new sse_js_1.SSEServerTransport('/message', res);
        transports.set(transport.sessionId, transport);
        transport.onclose = () => {
            transports.delete(transport.sessionId);
            console.log(`[server] Session closed: ${transport.sessionId}`);
        };
        await server.connect(transport);
        console.log(`[server] Session opened: ${transport.sessionId}`);
        return;
    }
    if (req.method === 'POST' && req.url?.startsWith('/message')) {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'sessionId query parameter is required' }));
            return;
        }
        const transport = transports.get(sessionId);
        if (!transport) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: `Session ${sessionId} not found` }));
            return;
        }
        await transport.handlePostMessage(req, res);
        return;
    }
    res.writeHead(404);
    res.end();
});
httpServer.listen(PORT, () => {
    console.log(`[server] GIF MCP server running on port ${PORT}`);
    console.log(`[server] Health: http://localhost:${PORT}/health`);
    console.log(`[server] SSE:    http://localhost:${PORT}/sse`);
    console.log(`[server] Tools registered: ${Array.from(registry_js_1.TOOL_REGISTRY.keys()).join(', ')}`);
});
process.on('SIGTERM', () => {
    console.log('[server] SIGTERM received — shutting down');
    httpServer.close(() => {
        console.log('[server] HTTP server closed');
        process.exit(0);
    });
});
//# sourceMappingURL=index.js.map