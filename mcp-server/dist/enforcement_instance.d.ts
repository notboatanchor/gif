export declare const gif: {
    validatePersona: (personaId: string) => Promise<import("./enforcement.js").PersonaValidationResult>;
    createSession: (params: {
        personaId: string;
        invocationContext: Record<string, unknown>;
    }) => Promise<string>;
    closeSession: (sessionId: string) => Promise<void>;
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
        blockedAt: import("./enforcement.js").EnforcementLayer;
        context: Record<string, unknown>;
    }) => Promise<void>;
    verifyIdentityBinding: (params: {
        identityToken: string;
    }) => Promise<import("./enforcement.js").IdentityBindingResult>;
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
    }) => Promise<import("./enforcement.js").CombinationPolicyCheckResult>;
};
//# sourceMappingURL=enforcement_instance.d.ts.map