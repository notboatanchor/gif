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
import { executePersonaCreate } from './tools/persona_create.js';
import { executePersonaRevoke } from './tools/persona_revoke.js';

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
    {
      name: 'persona_create',
      description: 'Create a new persona in the GIF registry. Issuing persona must have manage_personas in permitted_actions.',
      inputSchema: {
        type: 'object',
        properties: {
          persona_id:           { type: 'string', format: 'uuid', description: 'UUID of the issuing persona (must have manage_personas)' },
          issuing_entity:       { type: 'string', minLength: 1, description: 'Name of the entity issuing the persona' },
          purpose:              { type: 'string', minLength: 1, description: 'Human-readable declaration of business function' },
          created_by:           { type: 'string', minLength: 1, description: 'Identity of the actor creating the persona' },
          scope_definition:     { type: 'string', description: 'JSON string of scope: permitted_sources, permitted_actions, output_destinations, retention_policy' },
          valid_until:          { type: 'string', description: 'ISO 8601 datetime when persona expires' },
          valid_from:           { type: 'string', description: 'ISO 8601 datetime when persona becomes valid (defaults to now)' },
          max_delegation_depth: { type: 'number', minimum: 0, default: 0, description: 'Maximum delegation hops allowed (0 = no delegation)' },
          parent_persona_id:    { type: 'string', format: 'uuid', description: 'UUID of parent persona for delegated scope (optional)' },
        },
        required: ['persona_id', 'issuing_entity', 'purpose', 'created_by', 'scope_definition', 'valid_until'],
      },
    },
    {
      name: 'persona_revoke',
      description: 'Revoke a persona immediately. Issuing persona must have manage_personas in permitted_actions.',
      inputSchema: {
        type: 'object',
        properties: {
          persona_id:        { type: 'string', format: 'uuid', description: 'UUID of the issuing persona (must have manage_personas)' },
          target_persona_id: { type: 'string', format: 'uuid', description: 'UUID of the persona to revoke' },
          reason:            { type: 'string', minLength: 1, description: 'Reason for revocation — recorded in revocation_log' },
          revoked_by:        { type: 'string', minLength: 1, description: 'Identity of the actor initiating the revocation' },
        },
        required: ['persona_id', 'target_persona_id', 'reason', 'revoked_by'],
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

  // Create session — captures invocation context and persona state snapshot
  // for point-in-time reconstruction (Sprint 3)
  const sessionId = await createSession({
    personaId:         persona_id,
    invocationContext: {
      tool:              name,
      arguments:         args,
      persona_purpose:   validation.persona.purpose,
      persona_valid_until: validation.persona.valid_until,
    },
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

      case 'persona_create':
        result = await executePersonaCreate(
          {
            persona_id,
            issuing_entity:       args['issuing_entity'] as string,
            purpose:              args['purpose'] as string,
            created_by:           args['created_by'] as string,
            scope_definition:     args['scope_definition'] as string,
            valid_until:          args['valid_until'] as string,
            valid_from:           args['valid_from'] as string | undefined,
            max_delegation_depth: args['max_delegation_depth'] as number | undefined,
            parent_persona_id:    args['parent_persona_id'] as string | undefined,
          },
          validation.persona,
          sessionId
        );
        break;

      case 'persona_revoke':
        result = await executePersonaRevoke(
          {
            persona_id,
            target_persona_id: args['target_persona_id'] as string,
            reason:            args['reason'] as string,
            revoked_by:        args['revoked_by'] as string,
          },
          validation.persona,
          sessionId
        );
        break;

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

  } finally {
    // Determine event type and source_ref for persona lifecycle events.
    // persona_create and persona_revoke are first-class audit events —
    // event_type reflects the lifecycle action, not the generic 'tool_call'.
    // source_ref captures the new or target persona_id for reconstruction.
    let eventType = 'tool_call';
    let sourceRef: string | undefined;

    if (name === 'persona_create' || name === 'persona_revoke') {
      eventType = name;
      if (result && !result.isError) {
        try {
          const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;
          sourceRef = (
            parsed['persona_id'] as string | undefined ??
            parsed['target_persona_id'] as string | undefined
          );
        } catch {
          // sourceRef stays undefined — non-fatal
        }
      }
    }

    await logAuditEvent({
      personaId:       persona_id,
      sessionId,
      eventType,
      toolName:        name,
      outcome:         result === undefined || result.isError ? 'error' : 'success',
      sourceRef,
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
});

process.on('SIGTERM', () => {
  console.log('[server] SIGTERM received — shutting down');
  httpServer.close(() => {
    console.log('[server] HTTP server closed');
    process.exit(0);
  });
});
