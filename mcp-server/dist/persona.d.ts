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
    synthesis_depth?: number;
    output_destinations?: string[];
    data_classification_ceiling?: string;
    retention_policy?: string;
}
export type PersonaStatus = 'active' | 'suspended' | 'revoked' | 'expired';
export type GovernanceReviewStatus = 'auto_approved' | 'pending' | 'approved';
export type PersonaValidationResult = {
    valid: true;
    persona: Persona;
} | {
    valid: false;
    reason: PersonaInvalidReason;
    message: string;
};
export type PersonaInvalidReason = 'NOT_FOUND' | 'NOT_ACTIVE' | 'EXPIRED' | 'NOT_YET_VALID' | 'DB_ERROR';
export declare function validatePersona(personaId: string): Promise<PersonaValidationResult>;
export declare function logScopeViolation(params: {
    personaId: string;
    attemptedAction: string;
    toolName: string;
    context: Record<string, unknown>;
}): Promise<void>;
//# sourceMappingURL=persona.d.ts.map