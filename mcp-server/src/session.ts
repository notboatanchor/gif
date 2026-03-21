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

import { gif } from './enforcement_instance.js';

export const createSession  = gif.createSession;
export const closeSession   = gif.closeSession;
export const logAuditEvent  = gif.logAuditEvent;
