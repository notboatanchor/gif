"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=types.js.map