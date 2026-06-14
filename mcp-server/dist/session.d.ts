export declare const createSession: (params: {
    personaId: string;
    invocationContext: Record<string, unknown>;
}) => Promise<string>;
export declare const closeSession: (sessionId: string) => Promise<void>;
export declare const logAuditEvent: (params: {
    personaId: string;
    sessionId: string | null;
    eventType: string;
    toolName: string;
    outcome: import("./enforcement.js").AuditOutcome;
    sourceRef?: string;
    sourcesActed?: string[];
    flagged?: boolean;
    humanActorId?: string;
    purposeDeclared?: string;
}) => Promise<void>;
export declare const validateSessionHandle: (params: {
    personaId: string;
    gifSessionId: string;
    ttlSeconds: number;
}) => Promise<import("./enforcement.js").SessionHandleValidationResult>;
//# sourceMappingURL=session.d.ts.map