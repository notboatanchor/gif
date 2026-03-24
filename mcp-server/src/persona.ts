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
} from './enforcement.js';

// Functions — delegated to pool-bound enforcement instance
import { gif } from './enforcement_instance.js';

export const validatePersona        = gif.validatePersona;
export const logScopeViolation      = gif.logScopeViolation;
export const verifyIdentityBinding  = gif.verifyIdentityBinding;
export const logAuditRead           = gif.logAuditRead;
