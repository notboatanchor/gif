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
exports.logAuditEvent = exports.closeSession = exports.createSession = void 0;
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
const enforcement_instance_js_1 = require("./enforcement_instance.js");
exports.createSession = enforcement_instance_js_1.gif.createSession;
exports.closeSession = enforcement_instance_js_1.gif.closeSession;
exports.logAuditEvent = enforcement_instance_js_1.gif.logAuditEvent;
//# sourceMappingURL=session.js.map