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

// Types — re-exported from canonical enforcement module
export type {
  Persona,
  ScopeDefinition,
  PersonaStatus,
  GovernanceReviewStatus,
  EnforcementLayer,
  PersonaValidationResult,
  PersonaInvalidReason,
  IdentityBindingResult,
  EnforcementAction,
  CombinationPolicyCheckResult,
  SessionRejectionReason,
  SessionHandleValidationResult,
} from './enforcement.js';

// Functions — delegated to pool-bound enforcement instance
import { gif } from './enforcement_instance.js';

export const validatePersona        = gif.validatePersona;
export const logScopeViolation      = gif.logScopeViolation;
export const verifyIdentityBinding  = gif.verifyIdentityBinding;
export const logAuditRead           = gif.logAuditRead;
