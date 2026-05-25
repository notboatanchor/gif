export type { Persona, ScopeDefinition, PersonaStatus, GovernanceReviewStatus, EnforcementLayer, PersonaValidationResult, PersonaInvalidReason, IdentityBindingResult, EnforcementAction, CombinationPolicyCheckResult, SessionRejectionReason, SessionHandleValidationResult, } from './enforcement.js';
export declare const validatePersona: (personaId: string) => Promise<import("./enforcement.js").PersonaValidationResult>;
export declare const logScopeViolation: (params: {
    personaId: string;
    sessionId: string;
    attemptedAction: string;
    toolName: string;
    blockedAt: import("./enforcement.js").EnforcementLayer;
    context: Record<string, unknown>;
}) => Promise<void>;
export declare const verifyIdentityBinding: (params: {
    identityToken: string;
}) => Promise<import("./enforcement.js").IdentityBindingResult>;
export declare const logAuditRead: (params: {
    readerPersonaId: string;
    readerSessionId: string;
    queriedTable: string;
    filtersApplied?: Record<string, unknown>;
    rowsReturned: number;
    purposeDeclared?: string;
    partitionHint?: string;
}) => Promise<void>;
//# sourceMappingURL=persona.d.ts.map