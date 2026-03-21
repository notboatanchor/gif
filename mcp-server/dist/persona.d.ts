export type { Persona, ScopeDefinition, PersonaStatus, GovernanceReviewStatus, EnforcementLayer, PersonaValidationResult, PersonaInvalidReason, } from './enforcement.js';
export declare const validatePersona: (personaId: string) => Promise<import("./enforcement.js").PersonaValidationResult>;
export declare const logScopeViolation: (params: {
    personaId: string;
    sessionId: string;
    attemptedAction: string;
    toolName: string;
    blockedAt: import("./enforcement.js").EnforcementLayer;
    context: Record<string, unknown>;
}) => Promise<void>;
//# sourceMappingURL=persona.d.ts.map