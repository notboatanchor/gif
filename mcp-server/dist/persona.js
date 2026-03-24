"use strict";
// src/persona.ts
// =============================================================================
// Persona validation layer — re-export shim (ADR-027)
//
// Types re-exported from enforcement.ts (the canonical implementation).
// validatePersona and logScopeViolation delegate to the pool-bound instance
// in enforcement_instance.ts.
//
// Tool handlers and index.ts continue importing from this file unchanged.
// All enforcement logic lives in enforcement.ts — this file is a stable
// import surface, not an implementation.
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.logAuditRead = exports.verifyIdentityBinding = exports.logScopeViolation = exports.validatePersona = void 0;
// Functions — delegated to pool-bound enforcement instance
const enforcement_instance_js_1 = require("./enforcement_instance.js");
exports.validatePersona = enforcement_instance_js_1.gif.validatePersona;
exports.logScopeViolation = enforcement_instance_js_1.gif.logScopeViolation;
exports.verifyIdentityBinding = enforcement_instance_js_1.gif.verifyIdentityBinding;
exports.logAuditRead = enforcement_instance_js_1.gif.logAuditRead;
//# sourceMappingURL=persona.js.map