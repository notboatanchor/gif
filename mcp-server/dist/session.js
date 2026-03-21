"use strict";
// src/session.ts
// =============================================================================
// Session management — re-export shim (ADR-027)
//
// createSession, closeSession, and logAuditEvent delegate to the pool-bound
// instance in enforcement_instance.ts.
//
// index.ts continues importing from this file unchanged.
// All session/audit logic lives in enforcement.ts — this file is a stable
// import surface, not an implementation.
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.logAuditEvent = exports.closeSession = exports.createSession = void 0;
const enforcement_instance_js_1 = require("./enforcement_instance.js");
exports.createSession = enforcement_instance_js_1.gif.createSession;
exports.closeSession = enforcement_instance_js_1.gif.closeSession;
exports.logAuditEvent = enforcement_instance_js_1.gif.logAuditEvent;
//# sourceMappingURL=session.js.map