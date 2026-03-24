export declare const createSession: (params: {
    personaId: string;
    invocationContext: Record<string, unknown>;
}) => Promise<string>;
export declare const closeSession: (sessionId: string) => Promise<void>;
export declare const logAuditEvent: (params: {
    personaId: string;
    sessionId: string;
    eventType: string;
    toolName: string;
    outcome: string;
    sourceRef?: string;
    sourcesActed?: string[];
    flagged?: boolean;
    humanActorId?: string;
    purposeDeclared?: string;
}) => Promise<void>;
//# sourceMappingURL=session.d.ts.map