import type { Persona } from '../persona.js';
export type ToolResult = {
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
};
export interface ToolHandler {
    definition: {
        name: string;
        description: string;
        inputSchema: object;
    };
    execute: (args: Record<string, unknown>, persona: Persona, sessionId: string) => Promise<ToolResult>;
    auditMetadata?: (args: Record<string, unknown>, result: ToolResult) => {
        eventType: string;
        sourceRef?: string;
        humanActorId?: string;
    };
    skipSession?: boolean;
}
//# sourceMappingURL=types.d.ts.map