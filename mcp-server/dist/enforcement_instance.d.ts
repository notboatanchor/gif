export declare const gif: {
    validatePersona: (personaId: string) => Promise<import("./enforcement.js").PersonaValidationResult>;
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
        blockedAt: import("./enforcement.js").EnforcementLayer;
        context: Record<string, unknown>;
    }) => Promise<void>;
};
//# sourceMappingURL=enforcement_instance.d.ts.map