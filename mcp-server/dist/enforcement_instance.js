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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.gif = void 0;
// src/enforcement_instance.ts
// =============================================================================
// Module-level enforcement instance for the GIF MCP server.
//
// Calls createEnforcement(pool) once at module load time, binding all
// enforcement functions to the gif_app pool. persona.ts and session.ts
// re-export from here — enforcement.ts is the single implementation.
//
// ADR-027: enforcement.ts is the canonical implementation; this file
// ensures the GIF server itself uses it rather than duplicating the logic.
// =============================================================================
const db_js_1 = __importDefault(require("./db.js"));
const enforcement_js_1 = require("./enforcement.js");
exports.gif = (0, enforcement_js_1.createEnforcement)(db_js_1.default);
//# sourceMappingURL=enforcement_instance.js.map