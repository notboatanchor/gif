export interface Session {
    session_id: string;
    persona_id: string;
    started_at: Date;
    ended_at: Date | null;
    invocation_context: Record<string, unknown> | null;
}
export declare function createSession(params: {
    personaId: string;
    invocationContext: Record<string, unknown>;
}): Promise<string>;
export declare function closeSession(sessionId: string): Promise<void>;
export declare function logAuditEvent(params: {
    personaId: string;
    sessionId: string;
    eventType: string;
    toolName: string;
    outcome: string;
    sourceRef?: string;
    sourcesActed?: string[];
    flagged?: boolean;
    purposeDeclared?: string;
}): Promise<void>;
//# sourceMappingURL=session.d.ts.map