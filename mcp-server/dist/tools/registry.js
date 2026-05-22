"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOOL_REGISTRY = void 0;
// GIF framework tools
const persona_validate_js_1 = require("./persona_validate.js");
const persona_create_js_1 = require("./persona_create.js");
const persona_revoke_js_1 = require("./persona_revoke.js");
// Reference implementation adopter tools
const db_read_js_1 = require("./db_read.js");
const db_write_js_1 = require("./db_write.js");
// ---------------------------------------------------------------------------
// TOOL_REGISTRY
// Map of tool name → ToolHandler. Add new handlers here.
// Order is reflected in ListTools responses.
// ---------------------------------------------------------------------------
exports.TOOL_REGISTRY = new Map([
    // GIF framework tools
    [persona_validate_js_1.handler.definition.name, persona_validate_js_1.handler],
    [persona_create_js_1.handler.definition.name, persona_create_js_1.handler],
    [persona_revoke_js_1.handler.definition.name, persona_revoke_js_1.handler],
    // Adopter tools — reference implementation
    [db_read_js_1.handler.definition.name, db_read_js_1.handler],
    [db_write_js_1.handler.definition.name, db_write_js_1.handler],
]);
//# sourceMappingURL=registry.js.map