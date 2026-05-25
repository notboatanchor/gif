import type { Persona } from '../persona.js';
import type { ToolHandler } from './types.js';
export interface SessionStartArgs {
    persona_id: string;
    invocation_context?: Record<string, unknown>;
}
export declare function executeSessionStart(args: SessionStartArgs, persona: Persona, _sessionId: string): Promise<{
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
}>;
export declare const handler: ToolHandler;
//# sourceMappingURL=session_start.d.ts.map