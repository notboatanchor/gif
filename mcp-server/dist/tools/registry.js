"use strict";
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
// ship with the enforcement engine. Adopter tools (web_search, db_read,
// db_write) are registered here as part of this reference implementation.
//
// ADR-026: MCP server deployment topology
// ADR-027: GIF packaging model and extraction progression
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOOL_REGISTRY = void 0;
// GIF framework tools
const persona_validate_js_1 = require("./persona_validate.js");
const persona_create_js_1 = require("./persona_create.js");
const persona_revoke_js_1 = require("./persona_revoke.js");
// Reference implementation adopter tools
const web_search_js_1 = require("./web_search.js");
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
    [web_search_js_1.handler.definition.name, web_search_js_1.handler],
    [db_read_js_1.handler.definition.name, db_read_js_1.handler],
    [db_write_js_1.handler.definition.name, db_write_js_1.handler],
]);
//# sourceMappingURL=registry.js.map