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

// src/tools/registry.ts
// =============================================================================
// Tool registry — assembles the handler map for this MCP server instance.
//
// This file is the adopter's extension point (ADR-026, ADR-027).
// When Research Pipeline or FederalGraph build their own MCP server, they
// create their own registry.ts: import the GIF framework handlers and add
// their domain-specific tool handlers.
//
// The enforcement engine (index.ts) imports TOOL_REGISTRY and has no
// knowledge of which tools are registered or what they do.
//
// GIF framework tools (persona_validate, persona_create, persona_revoke)
// ship with the enforcement engine. Adopter tools (db_read, db_write)
// are registered here as part of this reference implementation.
//
// ADR-026: MCP server deployment topology
// ADR-027: GIF packaging model and extraction progression
// =============================================================================

import type { ToolHandler } from './types.js';

// GIF framework tools
import { handler as personaValidateHandler } from './persona_validate.js';
import { handler as personaCreateHandler   } from './persona_create.js';
import { handler as personaRevokeHandler   } from './persona_revoke.js';

// Reference implementation adopter tools
import { handler as dbReadHandler  } from './db_read.js';
import { handler as dbWriteHandler } from './db_write.js';

// ---------------------------------------------------------------------------
// TOOL_REGISTRY
// Map of tool name → ToolHandler. Add new handlers here.
// Order is reflected in ListTools responses.
// ---------------------------------------------------------------------------

export const TOOL_REGISTRY = new Map<string, ToolHandler>([
  // GIF framework tools
  [personaValidateHandler.definition.name, personaValidateHandler],
  [personaCreateHandler.definition.name,   personaCreateHandler],
  [personaRevokeHandler.definition.name,   personaRevokeHandler],

  // Adopter tools — reference implementation
  [dbReadHandler.definition.name,  dbReadHandler],
  [dbWriteHandler.definition.name, dbWriteHandler],
]);
