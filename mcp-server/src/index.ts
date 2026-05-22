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
// Streamable HTTP transport (ADR-002). Listens on PORT (default 3100).
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
// ADR-002: Streamable HTTP transport (replaces deprecated SSE transport)
// ADR-008: MCP server as the AI tool interface layer
// ADR-009: Persona-based permissions as infrastructure
// ADR-017: Governance audit schema stubs
// ADR-019: MCP server language, runtime, and port assignment
// ADR-026: MCP server deployment topology
// ADR-027: GIF packaging model and extraction progression
// =============================================================================

import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import http from 'http';
import { validatePersona } from './persona.js';
import { createSession, closeSession, logAuditEvent } from './session.js';
import { TOOL_REGISTRY } from './tools/registry.js';

const PORT = parseInt(process.env.PORT || '3100');

// ----------------------------------------------------------------------------
// MCP server factory — one Server instance per session
// (Server is the low-level API required for registry-driven dispatch — gif's
// enforcement engine needs full control over request handling, which the
// high-level McpServer abstraction does not expose.)
// ----------------------------------------------------------------------------

function createServer() {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- low-level API required for registry-driven dispatch
  const server = new Server(
    { name: 'gif-mcp-server', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  // --------------------------------------------------------------------------
  // ListTools — derived from registry, no hardcoded definitions
  // --------------------------------------------------------------------------

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: Array.from(TOOL_REGISTRY.values()).map(h => h.definition),
  }));

  // --------------------------------------------------------------------------
  // CallTool — enforcement engine + registry dispatch
  // Session lifecycle managed here — wraps all tool executions.
  // --------------------------------------------------------------------------

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
      return toolHandler.execute(args, validation.persona, '');
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
      result = await toolHandler.execute(args, validation.persona, sessionId);
    } finally {
      // Resolve audit event type and source_ref.
      // Tools with auditMetadata control their own event classification.
      // All others emit a generic tool_call event.
      let eventType:    string           = 'tool_call';
      let sourceRef:    string | undefined;
      let humanActorId: string | undefined;

      if (toolHandler.auditMetadata && result !== undefined) {
        const meta = toolHandler.auditMetadata(args, result);
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

  return server;
}

// ----------------------------------------------------------------------------
// Active Streamable HTTP transports — keyed by MCP session ID
// ----------------------------------------------------------------------------

const transports = new Map<string, StreamableHTTPServerTransport>();

// ----------------------------------------------------------------------------
// Body parsing — required for raw Node.js HTTP (no framework body parser)
// ----------------------------------------------------------------------------

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch {
        reject(new Error('Invalid JSON in request body'));
      }
    });
    req.on('error', reject);
  });
}

// ----------------------------------------------------------------------------
// HTTP request handler (async) — extracted so the createServer callback
// remains synchronous, satisfying TypeScript's void-return expectation.
// ----------------------------------------------------------------------------

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {

  console.log(`[server] ${req.method ?? ''} ${req.url ?? ''}`);

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'gif-mcp-server' }));
    return;
  }

  if (req.url === '/mcp') {

    if (req.method === 'POST') {
      let body: unknown;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request body' }));
        return;
      }

      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId && transports.has(sessionId)) {
        // Existing session — route to the established transport
        const transport = transports.get(sessionId);
        if (!transport) return; // unreachable: has() confirmed existence
        await transport.handleRequest(req, res, body);
        return;
      }

      if (!sessionId && isInitializeRequest(body)) {
        // New session initialization
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, transport);
            console.log(`[server] Session opened: ${sid}`);
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            transports.delete(sid);
            console.log(`[server] Session closed: ${sid}`);
          }
        };

        const server = createServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      // No valid session ID and not an initialize request
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: missing or invalid session' },
        id: null,
      }));
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (!sessionId || !transports.has(sessionId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or missing session ID' }));
        return;
      }

      const transport = transports.get(sessionId);
      if (!transport) return; // unreachable: has() confirmed existence
      await transport.handleRequest(req, res);
      return;
    }
  }

  res.writeHead(404);
  res.end();
}

// ----------------------------------------------------------------------------
// HTTP server
// ----------------------------------------------------------------------------

const httpServer = http.createServer((req, res) => {
  handleRequest(req, res).catch((err: unknown) => {
    console.error('[server] Unhandled request error:', err);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`[server] GIF MCP server running on port ${String(PORT)}`);
  console.log(`[server] Health: http://localhost:${String(PORT)}/health`);
  console.log(`[server] MCP:    http://localhost:${String(PORT)}/mcp`);
  console.log(`[server] Tools registered: ${Array.from(TOOL_REGISTRY.keys()).join(', ')}`);
});

process.on('SIGTERM', () => {
  console.log('[server] SIGTERM received — shutting down');
  for (const [sid, transport] of transports) {
    transport.close().catch((err: unknown) => {
      console.error(`[server] Error closing transport for session ${sid}:`, err);
    });
  }
  transports.clear();
  httpServer.close(() => {
    console.log('[server] HTTP server closed');
    process.exit(0);
  });
});
