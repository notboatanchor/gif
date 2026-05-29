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
// GIF framework tools
import { handler as personaValidateHandler } from './persona_validate.js';
import { handler as personaCreateHandler } from './persona_create.js';
import { handler as personaRevokeHandler } from './persona_revoke.js';
import { handler as sessionStartHandler } from './session_start.js';
import { handler as sessionCloseHandler } from './session_close.js';
// Reference implementation adopter tools
import { handler as dbReadHandler } from './db_read.js';
import { handler as dbWriteHandler } from './db_write.js';
// ---------------------------------------------------------------------------
// TOOL_REGISTRY
// Map of tool name → ToolHandler. Add new handlers here.
// Order is reflected in ListTools responses.
// ---------------------------------------------------------------------------
export const TOOL_REGISTRY = new Map([
    // GIF framework tools
    [personaValidateHandler.definition.name, personaValidateHandler],
    [personaCreateHandler.definition.name, personaCreateHandler],
    [personaRevokeHandler.definition.name, personaRevokeHandler],
    [sessionStartHandler.definition.name, sessionStartHandler],
    [sessionCloseHandler.definition.name, sessionCloseHandler],
    // Adopter tools — reference implementation
    [dbReadHandler.definition.name, dbReadHandler],
    [dbWriteHandler.definition.name, dbWriteHandler],
]);
//# sourceMappingURL=registry.js.map