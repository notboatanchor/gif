"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.gif = void 0;
const db_js_1 = __importDefault(require("./db.js"));
const enforcement_js_1 = require("./enforcement.js");
exports.gif = (0, enforcement_js_1.createEnforcement)(db_js_1.default);
//# sourceMappingURL=enforcement_instance.js.map