import type { Pool } from 'pg';
export interface Persona {
    persona_id: string;
    issuing_entity: string;
    purpose: string;
    created_by: string;
    scope_definition: ScopeDefinition;
    valid_from: Date;
    valid_until: Date | null;
    parent_persona_id: string | null;
    max_delegation_depth: number;
    status: PersonaStatus;
    data_classification_ceiling: string | null;
    combination_policy_ref: string | null;
    governance_review_status: GovernanceReviewStatus;
    created_at: Date;
    updated_at: Date;
}
export interface ScopeDefinition {
    permitted_sources?: string[];
    permitted_actions?: string[];
    permitted_write_targets?: string[];
    synthesis_depth?: number;
    output_destinations?: string[];
    data_classification_ceiling?: string;
    retention_policy?: string;
}
export type PersonaStatus = 'active' | 'suspended' | 'revoked' | 'expired';
export type GovernanceReviewStatus = 'auto_approved' | 'pending' | 'approved';
export type EnforcementLayer = 'mcp_validation' | 'synthesis_gate' | 'export_gate';
export type PersonaValidationResult = {
    valid: true;
    persona: Persona;
} | {
    valid: false;
    reason: PersonaInvalidReason;
    message: string;
};
export type PersonaInvalidReason = 'NOT_FOUND' | 'NOT_ACTIVE' | 'EXPIRED' | 'NOT_YET_VALID' | 'DB_ERROR';
export declare function createEnforcement(pool: Pool): {
    validatePersona: (personaId: string) => Promise<PersonaValidationResult>;
    createSession: (params: {
        personaId: string;
        invocationContext: Record<string, unknown>;
    }) => Promise<string>;
    closeSession: (sessionId: string) => Promise<void>;
    logAuditEvent: (params: {
        personaId: string;
        sessionId: string;
        eventType: string;
        toolName: string;
        outcome: string;
        sourceRef?: string;
        sourcesActed?: string[];
        flagged?: boolean;
        purposeDeclared?: string;
    }) => Promise<void>;
    logScopeViolation: (params: {
        personaId: string;
        sessionId: string;
        attemptedAction: string;
        toolName: string;
        blockedAt: EnforcementLayer;
        context: Record<string, unknown>;
    }) => Promise<void>;
};
//# sourceMappingURL=enforcement.d.ts.map