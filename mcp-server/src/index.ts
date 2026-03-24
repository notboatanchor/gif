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

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import http from 'http';
import { validatePersona } from './persona.js';
import { createSession, closeSession, logAuditEvent } from './session.js';
import { TOOL_REGISTRY } from './tools/registry.js';

const PORT = parseInt(process.env.PORT || '3100');

// ----------------------------------------------------------------------------
// MCP server instance
// ----------------------------------------------------------------------------

const server = new Server(
  { name: 'gif-mcp-server', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

// ----------------------------------------------------------------------------
// Active SSE transports — keyed by sessionId
// ----------------------------------------------------------------------------

const transports = new Map<string, SSEServerTransport>();

// ----------------------------------------------------------------------------
// ListTools — derived from registry, no hardcoded definitions
// ----------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Array.from(TOOL_REGISTRY.values()).map(h => h.definition),
}));

// ----------------------------------------------------------------------------
// CallTool — enforcement engine + registry dispatch
// Session lifecycle managed here — wraps all tool executions.
// ----------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (!args || typeof args !== 'object') {
    throw new McpError(ErrorCode.InvalidParams, 'Tool arguments are required');
  }

  const persona_id = args['persona_id'] as string | undefined;

  if (!persona_id) {
    throw new McpError(ErrorCode.InvalidParams, 'persona_id is required for all tool calls');
  }

  const toolHandler = TOOL_REGISTRY.get(name);
  if (!toolHandler) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }

  // Validate persona — always, regardless of skipSession
  const validation = await validatePersona(persona_id);
  if (!validation.valid) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ valid: false, reason: validation.reason, message: validation.message }) }],
      isError: true,
    };
  }

  // skipSession tools (persona_validate) — execute directly, no session or audit
  if (toolHandler.skipSession) {
    return toolHandler.execute(args as Record<string, unknown>, validation.persona, '');
  }

  // All other tools — create session, execute, audit, close session
  const sessionId = await createSession({
    personaId:         persona_id,
    invocationContext: {
      tool:                name,
      arguments:           args,
      persona_purpose:     validation.persona.purpose,
      persona_valid_until: validation.persona.valid_until,
    },
  });

  let result: Awaited<ReturnType<typeof toolHandler.execute>> | undefined;

  try {
    result = await toolHandler.execute(
      args as Record<string, unknown>,
      validation.persona,
      sessionId
    );
  } finally {
    // Resolve audit event type and source_ref.
    // Tools with auditMetadata control their own event classification.
    // All others emit a generic tool_call event.
    let eventType:    string           = 'tool_call';
    let sourceRef:    string | undefined;
    let humanActorId: string | undefined;

    if (toolHandler.auditMetadata && result !== undefined) {
      const meta = toolHandler.auditMetadata(args as Record<string, unknown>, result);
      eventType    = meta.eventType;
      sourceRef    = meta.sourceRef;
      humanActorId = meta.humanActorId;
    }

    await logAuditEvent({
      personaId:       persona_id,
      sessionId,
      eventType,
      toolName:        name,
      outcome:         result === undefined || result.isError ? 'error' : 'success',
      sourceRef,
      humanActorId,
      purposeDeclared: validation.persona.purpose,
    });
    await closeSession(sessionId);
  }

  return result;
});

// ----------------------------------------------------------------------------
// HTTP server and SSE transport
// ----------------------------------------------------------------------------

const httpServer = http.createServer(async (req, res) => {

  console.log(`[server] ${req.method} ${req.url}`);

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'gif-mcp-server' }));
    return;
  }

  if (req.method === 'GET' && req.url === '/sse') {
    const transport = new SSEServerTransport('/message', res);

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
  console.log(`[server] Tools registered: ${Array.from(TOOL_REGISTRY.keys()).join(', ')}`);
});

process.on('SIGTERM', () => {
  console.log('[server] SIGTERM received — shutting down');
  httpServer.close(() => {
    console.log('[server] HTTP server closed');
    process.exit(0);
  });
});
