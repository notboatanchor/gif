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

// src/tools/persona_revoke.ts
// =============================================================================
// persona_revoke tool handler
// Revokes a persona by setting status='revoked' and writing to revocation_log.
//
// Scope checks:
//   - Issuing persona must have 'manage_personas' in permitted_actions.
//
// Revocation is immediate. Active sessions under the target persona are
// closed within the same transaction — ended_at is set to now() for all
// sessions with ended_at IS NULL. active_sessions_terminated is the count
// of sessions closed. Any in-flight call that already passed persona
// validation will complete; subsequent calls will fail validation.
//
// The target persona_id is captured in source_ref on the audit event, making
// persona_revoke events first-class and reconstructible without joining
// revocation_log.
//
// ADR-008: MCP server as the AI tool interface layer
// ADR-009: Persona-based permissions as infrastructure
// ADR-017: Governance audit schema stubs
// =============================================================================

import pool from '../db.js';
import { Persona, logScopeViolation, EnforcementLayer } from '../persona.js';
import type { ToolHandler, ToolResult } from './types.js';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface PersonaRevokeArgs {
  persona_id:        string;   // issuer persona — must have manage_personas
  target_persona_id: string;   // persona to revoke
  reason:            string;   // required — recorded in revocation_log
  revoked_by:        string;   // human or system actor initiating the revocation
}

// ----------------------------------------------------------------------------
// executePersonaRevoke()
// ----------------------------------------------------------------------------

export async function executePersonaRevoke(
  args: PersonaRevokeArgs,
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
      toolName:        'persona_revoke',
      blockedAt:       'mcp_validation' as EnforcementLayer,
      context:         { target_persona_id: args.target_persona_id },
    });
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: `Persona ${args.persona_id} does not have 'manage_personas' in permitted_actions`,
      }) }],
      isError: true,
    };
  }

  // Fetch target persona to record previous status
  let previousStatus: string;
  try {
    const targetResult = await pool.query<{ status: string }>(
      `SELECT status FROM personas WHERE persona_id = $1 LIMIT 1`,
      [args.target_persona_id]
    );

    if (targetResult.rows.length === 0) {
      return {
        content: [{ type: 'text', text: JSON.stringify({
          error: `Target persona ${args.target_persona_id} not found`,
        }) }],
        isError: true,
      };
    }

    previousStatus = targetResult.rows[0].status;

    if (previousStatus === 'revoked') {
      return {
        content: [{ type: 'text', text: JSON.stringify({
          error: `Persona ${args.target_persona_id} is already revoked`,
        }) }],
        isError: true,
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[persona_revoke] Failed to fetch target persona:`, message);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'Revocation failed due to an internal error' }) }],
      isError: true,
    };
  }

  // Execute revocation in a transaction — status update, session close,
  // and revocation_log are atomic
  try {
    await pool.query('BEGIN');

    await pool.query(
      `UPDATE personas
       SET status = 'revoked', updated_at = now()
       WHERE persona_id = $1`,
      [args.target_persona_id]
    );

    // Close all open sessions for the revoked persona
    const sessionResult = await pool.query<{ count: string }>(
      `UPDATE sessions
       SET ended_at = now()
       WHERE persona_id = $1 AND ended_at IS NULL
       RETURNING session_id`,
      [args.target_persona_id]
    );
    const sessionsTerminated = sessionResult.rowCount ?? 0;

    await pool.query(
      `INSERT INTO revocation_log (
         persona_id,
         previous_status,
         new_status,
         reason,
         revoked_by,
         active_sessions_terminated
       ) VALUES ($1, $2, 'revoked', $3, $4, $5)`,
      [
        args.target_persona_id,
        previousStatus,
        args.reason,
        args.revoked_by,
        sessionsTerminated,
      ]
    );

    await pool.query('COMMIT');

    return {
      content: [{ type: 'text', text: JSON.stringify({
        target_persona_id:    args.target_persona_id,
        previous_status:      previousStatus,
        new_status:           'revoked',
        reason:               args.reason,
        revoked_by:           args.revoked_by,
        sessions_terminated:  sessionsTerminated,
        revoked:              true,
      }) }],
    };

  } catch (err) {
    await pool.query('ROLLBACK');
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[persona_revoke] Transaction failed:`, message);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'Revocation failed due to an internal error' }) }],
      isError: true,
    };
  }
}

// ----------------------------------------------------------------------------
// ToolHandler export — consumed by the tool registry in index.ts
// Framework tool: ships with GIF enforcement engine (ADR-026).
// Emits first-class persona_revoke audit event with source_ref = target persona_id.
// ----------------------------------------------------------------------------

export const handler: ToolHandler = {
  definition: {
    name: 'persona_revoke',
    description: 'Revoke a persona immediately. Issuing persona must have manage_personas in permitted_actions.',
    inputSchema: {
      type: 'object',
      properties: {
        persona_id:        { type: 'string', format: 'uuid', description: 'UUID of the issuing persona (must have manage_personas)' },
        target_persona_id: { type: 'string', format: 'uuid', description: 'UUID of the persona to revoke' },
        reason:            { type: 'string', minLength: 1, description: 'Reason for revocation — recorded in revocation_log' },
        revoked_by:        { type: 'string', minLength: 1, description: 'Identity of the actor initiating the revocation' },
      },
      required: ['persona_id', 'target_persona_id', 'reason', 'revoked_by'],
    },
  },
  execute: (args, persona, sessionId) =>
    executePersonaRevoke(
      {
        persona_id:        args['persona_id'] as string,
        target_persona_id: args['target_persona_id'] as string,
        reason:            args['reason'] as string,
        revoked_by:        args['revoked_by'] as string,
      },
      persona,
      sessionId
    ),
  auditMetadata: (args, result: ToolResult) => {
    let sourceRef: string | undefined;
    if (!result.isError) {
      try {
        const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;
        sourceRef = parsed['target_persona_id'] as string | undefined;
      } catch { /* non-fatal */ }
    }
    // Fall back to args if result parsing fails
    if (!sourceRef) sourceRef = args['target_persona_id'] as string | undefined;
    return { eventType: 'persona_revoke', sourceRef };
  },
};
