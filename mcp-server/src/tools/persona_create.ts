// src/tools/persona_create.ts
// =============================================================================
// persona_create tool handler
// Creates a new persona in the GIF registry.
//
// Scope checks:
//   - Issuing persona must have 'manage_personas' in permitted_actions.
//
// The issuing persona's session and audit trail record the creation event.
// The new persona_id is returned and captured in source_ref on the audit event.
//
// Persona lifecycle audit events use event_type='persona_create' rather
// than 'tool_call' to make them first-class in the audit trail and
// distinguishable in point-in-time reconstruction.
//
// ADR-008: MCP server as the AI tool interface layer
// ADR-009: Persona-based permissions as infrastructure
// ADR-017: Governance audit schema stubs
// =============================================================================

import pool from '../db.js';
import { Persona, logScopeViolation, EnforcementLayer } from '../persona.js';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface PersonaCreateArgs {
  persona_id:           string;   // issuer persona — must have manage_personas
  issuing_entity:       string;
  purpose:              string;
  created_by:           string;
  scope_definition:     string;   // JSON string
  valid_until:          string;   // ISO 8601 datetime
  valid_from?:          string;   // ISO 8601 datetime — defaults to now()
  max_delegation_depth?: number;  // defaults to 0
  parent_persona_id?:   string;   // UUID — optional parent for delegated personas
}

// ----------------------------------------------------------------------------
// executePersonaCreate()
// ----------------------------------------------------------------------------

export async function executePersonaCreate(
  args: PersonaCreateArgs,
  persona: Persona,
  sessionId: string
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {

  // Scope check — issuer must have manage_personas
  const scope = persona.scope_definition;
  if (!scope.permitted_actions || !scope.permitted_actions.includes('manage_personas')) {
    await logScopeViolation({
      personaId:       args.persona_id,
      sessionId,
      attemptedAction: 'manage_personas',
      toolName:        'persona_create',
      blockedAt:       'mcp_validation' as EnforcementLayer,
      context:         { issuing_entity: args.issuing_entity, purpose: args.purpose },
    });
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: `Persona ${args.persona_id} does not have 'manage_personas' in permitted_actions`,
      }) }],
      isError: true,
    };
  }

  // Parse scope_definition
  let parsedScope: Record<string, unknown>;
  try {
    parsedScope = JSON.parse(args.scope_definition);
  } catch {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: 'scope_definition must be a valid JSON string',
      }) }],
      isError: true,
    };
  }

  // Insert new persona
  try {
    const result = await pool.query<{ persona_id: string }>(
      `INSERT INTO personas (
         issuing_entity,
         purpose,
         created_by,
         scope_definition,
         valid_from,
         valid_until,
         max_delegation_depth,
         parent_persona_id
       ) VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()), $6, $7, $8)
       RETURNING persona_id`,
      [
        args.issuing_entity,
        args.purpose,
        args.created_by,
        JSON.stringify(parsedScope),
        args.valid_from ?? null,
        args.valid_until,
        args.max_delegation_depth ?? 0,
        args.parent_persona_id ?? null,
      ]
    );

    const newPersonaId = result.rows[0].persona_id;

    return {
      content: [{ type: 'text', text: JSON.stringify({
        persona_id:     newPersonaId,
        issuing_entity: args.issuing_entity,
        purpose:        args.purpose,
        created_by:     args.created_by,
        valid_until:    args.valid_until,
        created:        true,
      }) }],
    };

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[persona_create] Insert failed:`, message);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: `Persona creation failed: ${message}` }) }],
      isError: true,
    };
  }
}
