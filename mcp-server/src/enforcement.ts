// src/enforcement.ts
// =============================================================================
// GIF enforcement module — adopter import point (ADR-027 Stage 1)
//
// This file is the public API surface that adopters import to build their
// own MCP servers on top of GIF enforcement (ADR-026).
//
// Adopter usage pattern:
//   import { createEnforcement } from 'gif-enforcement';
//   import pool from './db.js';
//   export const { validatePersona, createSession, closeSession, logAuditEvent }
//     = createEnforcement(pool);
//
// The pool is injected by the adopter so that each MCP server runs under its
// own application credentials (gif_app, research_app, etc.) — ADR-028.
//
// GIF-MCP-server's own index.ts imports this module with the gif_app pool.
// Research Pipeline's enforcement.ts imports this module with the research_app pool.
//
// ADR-026: GIF enforcement as importable module; adopter builds the server
// ADR-027: Stage 1 — code-level extraction before physical repo split
// ADR-028: Per-adopter application credentials injected at construction time
// =============================================================================

import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Types — exported for adopter use, no pool dependency
// ---------------------------------------------------------------------------

export interface Persona {
  persona_id:                  string;
  issuing_entity:              string;
  purpose:                     string;
  created_by:                  string;
  scope_definition:            ScopeDefinition;
  valid_from:                  Date;
  valid_until:                 Date | null;
  parent_persona_id:           string | null;
  max_delegation_depth:        number;
  status:                      PersonaStatus;
  data_classification_ceiling: string | null;
  combination_policy_ref:      string | null;
  governance_review_status:    GovernanceReviewStatus;
  created_at:                  Date;
  updated_at:                  Date;
}

export interface ScopeDefinition {
  permitted_sources?:           string[];
  permitted_actions?:           string[];
  permitted_write_targets?:     string[];
  synthesis_depth?:             number;
  output_destinations?:         string[];
  data_classification_ceiling?: string;
  retention_policy?:            string;
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

export type EnforcementLayer =
  | 'mcp_validation'
  | 'synthesis_gate'
  | 'export_gate';

export type PersonaValidationResult =
  | { valid: true;  persona: Persona }
  | { valid: false; reason: PersonaInvalidReason; message: string };

export type PersonaInvalidReason =
  | 'NOT_FOUND'
  | 'NOT_ACTIVE'
  | 'EXPIRED'
  | 'NOT_YET_VALID'
  | 'DB_ERROR';

// ---------------------------------------------------------------------------
// createEnforcement()
// Factory that returns enforcement functions bound to the provided pool.
// Call once at MCP server startup with the application's DB pool.
// ---------------------------------------------------------------------------

export function createEnforcement(pool: Pool) {
  return {
    validatePersona: (personaId: string) =>
      _validatePersona(pool, personaId),

    createSession: (params: {
      personaId:         string;
      invocationContext: Record<string, unknown>;
    }) => _createSession(pool, params),

    closeSession: (sessionId: string) =>
      _closeSession(pool, sessionId),

    logAuditEvent: (params: {
      personaId:        string;
      sessionId:        string;
      eventType:        string;
      toolName:         string;
      outcome:          string;
      sourceRef?:       string;
      sourcesActed?:    string[];
      flagged?:         boolean;
      purposeDeclared?: string;
    }) => _logAuditEvent(pool, params),

    logScopeViolation: (params: {
      personaId:       string;
      sessionId:       string;
      attemptedAction: string;
      toolName:        string;
      blockedAt:       EnforcementLayer;
      context:         Record<string, unknown>;
    }) => _logScopeViolation(pool, params),
  };
}

// ---------------------------------------------------------------------------
// _validatePersona()
// ---------------------------------------------------------------------------

async function _validatePersona(
  pool: Pool,
  personaId: string
): Promise<PersonaValidationResult> {
  if (!personaId || typeof personaId !== 'string' || personaId.trim() === '') {
    return {
      valid:   false,
      reason:  'NOT_FOUND',
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
        valid:   false,
        reason:  'NOT_FOUND',
        message: `Persona ${personaId} not found`,
      };
    }

    persona = result.rows[0];

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown database error';
    console.error(`[gif-enforcement] DB error validating persona ${personaId}:`, message);
    return {
      valid:   false,
      reason:  'DB_ERROR',
      message: `Database error during persona validation: ${message}`,
    };
  }

  if (persona.status !== 'active') {
    return {
      valid:   false,
      reason:  'NOT_ACTIVE',
      message: `Persona ${personaId} is not active (status: ${persona.status})`,
    };
  }

  const now = new Date();

  if (persona.valid_from && persona.valid_from > now) {
    return {
      valid:   false,
      reason:  'NOT_YET_VALID',
      message: `Persona ${personaId} is not yet valid (valid_from: ${persona.valid_from.toISOString()})`,
    };
  }

  if (persona.valid_until && persona.valid_until < now) {
    return {
      valid:   false,
      reason:  'EXPIRED',
      message: `Persona ${personaId} has expired (valid_until: ${persona.valid_until.toISOString()})`,
    };
  }

  return { valid: true, persona };
}

// ---------------------------------------------------------------------------
// _createSession()
// ---------------------------------------------------------------------------

async function _createSession(
  pool: Pool,
  params: {
    personaId:         string;
    invocationContext: Record<string, unknown>;
  }
): Promise<string> {
  const result = await pool.query<{ session_id: string }>(
    `INSERT INTO sessions (persona_id, invocation_context)
     VALUES ($1, $2)
     RETURNING session_id`,
    [params.personaId, JSON.stringify(params.invocationContext)]
  );
  return result.rows[0].session_id;
}

// ---------------------------------------------------------------------------
// _closeSession()
// Does not throw — a close failure must not mask the tool response.
// ---------------------------------------------------------------------------

async function _closeSession(pool: Pool, sessionId: string): Promise<void> {
  try {
    await pool.query(
      `UPDATE sessions SET ended_at = now() WHERE session_id = $1`,
      [sessionId]
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[gif-enforcement] Failed to close session ${sessionId}:`, message);
  }
}

// ---------------------------------------------------------------------------
// _logAuditEvent()
// Does not throw — audit failure must not mask the tool response.
// ---------------------------------------------------------------------------

async function _logAuditEvent(
  pool: Pool,
  params: {
    personaId:        string;
    sessionId:        string;
    eventType:        string;
    toolName:         string;
    outcome:          string;
    sourceRef?:       string;
    sourcesActed?:    string[];
    flagged?:         boolean;
    purposeDeclared?: string;
  }
): Promise<void> {
  const {
    personaId,
    sessionId,
    eventType,
    toolName,
    outcome,
    sourceRef,
    sourcesActed = [],
    flagged = false,
    purposeDeclared,
  } = params;

  try {
    await pool.query(
      `INSERT INTO audit_events (
         persona_id,
         session_id,
         event_type,
         tool_name,
         outcome,
         source_ref,
         sources_touched,
         flagged,
         purpose_declared
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        personaId,
        sessionId,
        eventType,
        toolName,
        outcome,
        sourceRef ?? null,
        JSON.stringify(sourcesActed),
        flagged,
        purposeDeclared ?? null,
      ]
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[gif-enforcement] Failed to log audit event for session ${sessionId}:`, message);
  }
}

// ---------------------------------------------------------------------------
// _logScopeViolation()
// Does not throw — logging failure must not mask the rejection response.
// ---------------------------------------------------------------------------

async function _logScopeViolation(
  pool: Pool,
  params: {
    personaId:       string;
    sessionId:       string;
    attemptedAction: string;
    toolName:        string;
    blockedAt:       EnforcementLayer;
    context:         Record<string, unknown>;
  }
): Promise<void> {
  const { personaId, sessionId, attemptedAction, toolName, blockedAt, context } = params;

  try {
    await pool.query(
      `INSERT INTO scope_violations (
         persona_id,
         session_id,
         attempted_action,
         attempted_tool,
         blocked_at,
         blocked,
         context_snapshot
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        personaId,
        sessionId,
        attemptedAction,
        toolName,
        blockedAt,
        true,
        JSON.stringify(context),
      ]
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[gif-enforcement] Failed to log scope violation for persona ${personaId}:`, message);
  }
}
