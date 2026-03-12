// src/index.ts
// =============================================================================
// GIF MCP server — entry point
// HTTP/SSE transport. Listens on PORT (default 3100).
//
// Tool implementations:
//   Step 3: persona_validate
//   Step 4: web_search
//   Step 5: db_read
//   Step 6: db_write
//
// Session lifecycle per tool call:
//   1. Validate persona
//   2. Create session record
//   3. Execute tool (with sessionId for audit/violation logging)
//   4. Log audit event
//   5. Close session
//
// ADR-008: MCP server as the AI tool interface layer
// ADR-009: Persona-based permissions as infrastructure
// ADR-017: Governance audit schema stubs
// ADR-019: MCP server language, runtime, and port assignment
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
import { executeWebSearch } from './tools/web_search.js';
import { executeDbRead } from './tools/db_read.js';
import { executeDbWrite } from './tools/db_write.js';

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
// Tool definitions
// ----------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'persona_validate',
      description: 'Validate a persona by ID. Returns persona details if valid, error if not.',
      inputSchema: {
        type: 'object',
        properties: {
          persona_id: { type: 'string', format: 'uuid', description: 'UUID of the persona to validate' },
        },
        required: ['persona_id'],
      },
    },
    {
      name: 'web_search',
      description: 'Search the web via SearXNG. Persona scope is validated before execution.',
      inputSchema: {
        type: 'object',
        properties: {
          persona_id:  { type: 'string', format: 'uuid', description: 'UUID of the active persona' },
          query:       { type: 'string', minLength: 1, description: 'Search query string' },
          max_results: { type: 'number', minimum: 1, maximum: 20, default: 10, description: 'Maximum number of results to return' },
        },
        required: ['persona_id', 'query'],
      },
    },
    {
      name: 'db_read',
      description: 'Read from the GIF Postgres database. Persona scope is validated before execution.',
      inputSchema: {
        type: 'object',
        properties: {
          persona_id: { type: 'string', format: 'uuid', description: 'UUID of the active persona' },
          table:      { type: 'string', minLength: 1, description: 'Table name to query' },
          filters:    { type: 'string', description: 'Optional JSON string of filter conditions e.g. {"status":"active"}' },
          limit:      { type: 'number', minimum: 1, maximum: 1000, default: 100, description: 'Maximum rows to return' },
        },
        required: ['persona_id', 'table'],
      },
    },
    {
      name: 'db_write',
      description: 'Write to the GIF Postgres database. Persona scope and output destinations are validated before execution.',
      inputSchema: {
        type: 'object',
        properties: {
          persona_id: { type: 'string', format: 'uuid', description: 'UUID of the active persona' },
          table:      { type: 'string', minLength: 1, description: 'Table name to write to' },
          record:     { type: 'string', description: 'JSON string of the record to insert e.g. {"key":"value"}' },
        },
        required: ['persona_id', 'table', 'record'],
      },
    },
  ],
}));

// ----------------------------------------------------------------------------
// Tool call handler
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

  // persona_validate does not create a session — it is a diagnostic tool
  if (name === 'persona_validate') {
    const result = await validatePersona(persona_id);

    if (!result.valid) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ valid: false, reason: result.reason, message: result.message }),
        }],
        isError: true,
      };
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          valid:            true,
          persona_id:       result.persona.persona_id,
          issuing_entity:   result.persona.issuing_entity,
          purpose:          result.persona.purpose,
          status:           result.persona.status,
          valid_from:       result.persona.valid_from,
          valid_until:      result.persona.valid_until,
          scope_definition: result.persona.scope_definition,
        }),
      }],
    };
  }

  // All other tools — validate persona then create session
  const validation = await validatePersona(persona_id);
  if (!validation.valid) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: validation.message }) }],
      isError: true,
    };
  }

  // Create session — captures invocation context for audit trail
  const sessionId = await createSession({
    personaId:         persona_id,
    invocationContext: { tool: name, arguments: args },
  });

  let result: { content: Array<{ type: 'text'; text: string }>; isError?: boolean } | undefined;
  try {
    switch (name) {

      case 'web_search':
        result = await executeWebSearch(
          {
            persona_id,
            query:       args['query'] as string,
            max_results: (args['max_results'] as number | undefined) ?? 10,
          },
          validation.persona,
          sessionId
        );
        break;

      case 'db_read':
        result = await executeDbRead(
          {
            persona_id,
            table:   args['table'] as string,
            filters: args['filters'] as string | undefined,
            limit:   (args['limit'] as number | undefined) ?? 100,
          },
          validation.persona,
          sessionId
        );
        break;

      case 'db_write':
        result = await executeDbWrite(
          {
            persona_id,
            table:  args['table'] as string,
            record: args['record'] as string,
          },
          validation.persona,
          sessionId
        );
        break;

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

  } finally {
    // Log audit event and close session regardless of outcome
    await logAuditEvent({
      personaId: persona_id,
      sessionId,
      eventType: 'tool_call',
      toolName:  name,
      outcome:   result === undefined || result.isError ? 'error' : 'success',
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
});

process.on('SIGTERM', () => {
  console.log('[server] SIGTERM received — shutting down');
  httpServer.close(() => {
    console.log('[server] HTTP server closed');
    process.exit(0);
  });
});
