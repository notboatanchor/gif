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
exports.logAuditRead = exports.verifyIdentityBinding = exports.logScopeViolation = exports.validatePersona = void 0;
// Functions — delegated to pool-bound enforcement instance
const enforcement_instance_js_1 = require("./enforcement_instance.js");
exports.validatePersona = enforcement_instance_js_1.gif.validatePersona;
exports.logScopeViolation = enforcement_instance_js_1.gif.logScopeViolation;
exports.verifyIdentityBinding = enforcement_instance_js_1.gif.verifyIdentityBinding;
exports.logAuditRead = enforcement_instance_js_1.gif.logAuditRead;
//# sourceMappingURL=persona.js.map