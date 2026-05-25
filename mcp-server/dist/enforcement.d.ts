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
export type PersonaInvalidReason = 'NOT_FOUND' | 'NOT_ACTIVE' | 'EXPIRED' | 'NOT_YET_VALID' | 'DB_ERROR' | 'GOVERNANCE_REVIEW_REQUIRED';
export type SessionRejectionReason = 'SESSION_NOT_FOUND' | 'SESSION_PERSONA_MISMATCH' | 'SESSION_CLOSED' | 'SESSION_EXPIRED' | 'SESSION_DB_ERROR';
export type SessionHandleValidationResult = {
    valid: true;
    sessionId: string;
} | {
    valid: false;
    reason: SessionRejectionReason;
    message: string;
    auditSessionId: string | null;
};
export type IdentityBindingResult = {
    valid: true;
    assignmentId: string;
    externalUserId: string;
} | {
    valid: false;
    reason: string;
};
export type EnforcementAction = 'block' | 'flag' | 'require_human_review';
export type CombinationPolicyCheckResult = {
    triggered: false;
} | {
    triggered: true;
    policyId: string;
    policyName: string;
    enforcementAction: EnforcementAction;
    sensitivityResult: string;
    exempt: boolean;
};
export declare function createEnforcement(pool: Pool): {
    validatePersona: (personaId: string) => Promise<PersonaValidationResult>;
    createSession: (params: {
        personaId: string;
        invocationContext: Record<string, unknown>;
    }) => Promise<string>;
    closeSession: (sessionId: string) => Promise<void>;
    validateSessionHandle: (params: {
        personaId: string;
        gifSessionId: string;
        ttlSeconds: number;
    }) => Promise<SessionHandleValidationResult>;
    logAuditEvent: (params: {
        personaId: string;
        sessionId: string | null;
        eventType: string;
        toolName: string;
        outcome: string;
        sourceRef?: string;
        sourcesActed?: string[];
        flagged?: boolean;
        humanActorId?: string;
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
    verifyIdentityBinding: (params: {
        identityToken: string;
    }) => Promise<IdentityBindingResult>;
    logAuditRead: (params: {
        readerPersonaId: string;
        readerSessionId: string;
        queriedTable: string;
        filtersApplied?: Record<string, unknown>;
        rowsReturned: number;
        purposeDeclared?: string;
        partitionHint?: string;
    }) => Promise<void>;
    checkCombinationPolicies: (params: {
        sessionId: string;
        personaId: string;
        incomingSourceRefs: string[];
    }) => Promise<CombinationPolicyCheckResult>;
};
//# sourceMappingURL=enforcement.d.ts.map