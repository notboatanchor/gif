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

// src/tools/types.ts
// =============================================================================
// ToolHandler — the interface every tool handler must satisfy.
//
// The enforcement engine (index.ts) knows only this interface.
// It has no knowledge of which tools exist or what they do.
//
// Adopters building on the GIF enforcement engine assemble a registry of
// ToolHandler objects. The enforcement engine iterates the registry for
// ListTools and dispatches by name for CallTool.
//
// ADR-026: MCP server deployment topology
// ADR-027: GIF packaging model and extraction progression
// =============================================================================

import type { Tool } from '@modelcontextprotocol/server';
import type { Persona } from '../persona.js';

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export interface ToolHandler {
  // MCP tool definition — returned verbatim in ListTools responses.
  definition: Tool;

  // Tool execution function. Always receives validated persona and sessionId.
  // Session is created before execute() is called unless skipSession is true.
  execute: (
    args:      Record<string, unknown>,
    persona:   Persona,
    sessionId: string
  ) => Promise<ToolResult>;

  // Optional: returns the audit event_type and source_ref to record.
  // Defaults to event_type='tool_call', source_ref=undefined when absent.
  // Framework tools (persona_create, persona_revoke) use this to emit
  // first-class lifecycle events instead of generic tool_call events.
  auditMetadata?: (
    args:   Record<string, unknown>,
    result: ToolResult
  ) => { eventType: string; sourceRef?: string; humanActorId?: string };

  // If true, the tool is invoked without creating a session.
  // persona_validate is diagnostic — it should not produce audit events.
  skipSession?: boolean;
}
