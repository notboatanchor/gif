// src/persona.ts
// =============================================================================
// Persona validation layer
// Every tool call passes through validatePersona() before any tool executes.
// Validates existence, active status, and temporal bounds against the
// personas table. Returns the full persona record on success so tool
// handlers can check scope without a second database round trip.
//
// Scope checking (permitted_actions, permitted_sources, output_destinations)
// is handled per-tool in the individual tool handlers — not here.
// This layer is responsible for: does this persona exist and is it valid to use.
// =============================================================================

import pool from './db.js';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

// Mirrors the personas table columns exactly.
// Nullable fields reflect the schema — do not assume presence in tool handlers.
export interface Persona {
  persona_id:                 string;
  issuing_entity:             string;
  purpose:                    string;
  created_by:                 string;
  scope_definition:           ScopeDefinition;
  valid_from:                 Date;
  valid_until:                Date | null;
  parent_persona_id:          string | null;
  max_delegation_depth:       number;
  status:                     PersonaStatus;
  data_classification_ceiling: string | null;
  combination_policy_ref:     string | null;
  governance_review_status:   GovernanceReviewStatus;
  created_at:                 Date;
  updated_at:                 Date;
}

// Scope definition stored as JSONB in Postgres.
// Fields are optional at the type level — enforcement logic checks presence.
export interface ScopeDefinition {
  permitted_sources?:            string[];
  permitted_actions?:            string[];
  synthesis_depth?:              number;
  output_destinations?:          string[];
  data_classification_ceiling?:  string;
  retention_policy?:             string;
}

export type PersonaStatus =
  | 'active'
  | 'suspended'
  | 'revoked'
  | 'expired';

export type GovernanceReviewStatus =
  | 'auto_approved'
  | 'pending'
  | 'approved';

// ----------------------------------------------------------------------------
// Validation result
// Always check .valid before accessing .persona.
// ----------------------------------------------------------------------------

export type PersonaValidationResult =
  | { valid: true;  persona: Persona }
  | { valid: false; reason: PersonaInvalidReason; message: string };

export type PersonaInvalidReason =
  | 'NOT_FOUND'
  | 'NOT_ACTIVE'
  | 'EXPIRED'
  | 'NOT_YET_VALID'
  | 'DB_ERROR';

// ----------------------------------------------------------------------------
// validatePersona()
// Primary entry point. Called by every tool handler before execution.
// ----------------------------------------------------------------------------

export async function validatePersona(
  personaId: string
): Promise<PersonaValidationResult> {

  // Guard against obviously invalid input before hitting the database.
  if (!personaId || typeof personaId !== 'string' || personaId.trim() === '') {
    return {
      valid: false,
      reason: 'NOT_FOUND',
      message: 'persona_id is required and must be a non-empty string',
    };
  }

  let persona: Persona;

  try {
    const result = await pool.query<Persona>(
      `SELECT
         persona_id,
         issuing_entity,
         purpose,
         created_by,
         scope_definition,
         valid_from,
         valid_until,
         parent_persona_id,
         max_delegation_depth,
         status,
         data_classification_ceiling,
         combination_policy_ref,
         governance_review_status,
         created_at,
         updated_at
       FROM personas
       WHERE persona_id = $1
       LIMIT 1`,
      [personaId]
    );

    if (result.rows.length === 0) {
      return {
        valid: false,
        reason: 'NOT_FOUND',
        message: `Persona ${personaId} not found`,
      };
    }

    persona = result.rows[0];

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown database error';
    console.error(`[persona] Database error validating persona ${personaId}:`, message);
    return {
      valid: false,
      reason: 'DB_ERROR',
      message: `Database error during persona validation: ${message}`,
    };
  }

  // Status check — must be active.
  // Suspended, revoked, and expired are all distinct failure modes
  // but all result in rejection at this layer.
  if (persona.status !== 'active') {
    return {
      valid: false,
      reason: 'NOT_ACTIVE',
      message: `Persona ${personaId} is not active (status: ${persona.status})`,
    };
  }

  const now = new Date();

  // Temporal check — valid_from.
  // Persona record exists but activation window has not started.
  if (persona.valid_from && persona.valid_from > now) {
    return {
      valid: false,
      reason: 'NOT_YET_VALID',
      message: `Persona ${personaId} is not yet valid (valid_from: ${persona.valid_from.toISOString()})`,
    };
  }

  // Temporal check — valid_until.
  // Null valid_until means no expiry declared — permitted by schema.
  if (persona.valid_until && persona.valid_until < now) {
    return {
      valid: false,
      reason: 'EXPIRED',
      message: `Persona ${personaId} has expired (valid_until: ${persona.valid_until.toISOString()})`,
    };
  }

  // All checks passed.
  return { valid: true, persona };
}

// ----------------------------------------------------------------------------
// logScopeViolation()
// Called by tool handlers when a valid persona attempts an action outside
// its declared scope. Persona existence is already confirmed at this point.
// Records the violation in scope_violations for audit purposes.
// Does not throw — a logging failure must not mask the rejection response.
// ----------------------------------------------------------------------------

export async function logScopeViolation(params: {
  personaId:       string;
  attemptedAction: string;
  toolName:        string;
  context:         Record<string, unknown>;
}): Promise<void> {

  const { personaId, attemptedAction, toolName, context } = params;

  try {
    await pool.query(
      `INSERT INTO scope_violations (
         persona_id,
         attempted_action,
         blocked_at,
         context_snapshot
       ) VALUES ($1, $2, now(), $3)`,
      [
        personaId,
        `${toolName}:${attemptedAction}`,
        JSON.stringify(context),
      ]
    );
  } catch (err) {
    // Log but do not throw — violation logging failure must not prevent
    // the rejection response from reaching the caller.
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[persona] Failed to log scope violation for persona ${personaId}:`, message);
  }
}
