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

// src/tools/persona_validate.ts
// =============================================================================
// persona_validate tool handler
// Validates a persona and returns its details if valid.
//
// Diagnostic tool — does not create a session or emit an audit event.
// skipSession: true — the enforcement engine validates the persona before
// calling execute(), but does not create a session record.
//
// Framework tool: ships with GIF enforcement engine (ADR-026).
//
// ADR-008: MCP server as the AI tool interface layer
// ADR-009: Persona-based permissions as infrastructure
// =============================================================================

import type { Persona } from '../persona.js';
import type { ToolHandler } from './types.js';

// ----------------------------------------------------------------------------
// executePersonaValidate()
// Called only after the enforcement engine has already validated the persona.
// Returns the persona details in a consistent format.
// ----------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/require-await -- ToolHandler.execute must return Promise<ToolResult>; this implementation is synchronous but the interface contract requires async.
export async function executePersonaValidate(
  _args:     Record<string, unknown>,
  persona:   Persona,
  _sessionId: string
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        valid:            true,
        persona_id:       persona.persona_id,
        issuing_entity:   persona.issuing_entity,
        purpose:          persona.purpose,
        status:           persona.status,
        valid_from:       persona.valid_from,
        valid_until:      persona.valid_until,
        scope_definition: persona.scope_definition,
      }),
    }],
  };
}

// ----------------------------------------------------------------------------
// ToolHandler export — consumed by the tool registry in index.ts
// Framework tool: ships with GIF enforcement engine (ADR-026).
// skipSession: true — persona is validated but no session is created.
// ----------------------------------------------------------------------------

export const handler: ToolHandler = {
  definition: {
    name: 'persona_validate',
    description: 'Validate a persona by ID. Returns persona details if valid, error if not. Diagnostic — does not create a session.',
    inputSchema: {
      type: 'object',
      properties: {
        persona_id: { type: 'string', format: 'uuid', description: 'UUID of the persona to validate' },
      },
      required: ['persona_id'],
    },
  },
  execute:     executePersonaValidate,
  skipSession: true,
};
