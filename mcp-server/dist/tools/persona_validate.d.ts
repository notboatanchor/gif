import type { Persona } from '../persona.js';
import type { ToolHandler } from './types.js';
export declare function executePersonaValidate(_args: Record<string, unknown>, persona: Persona, _sessionId: string): Promise<{
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
}>;
export declare const handler: ToolHandler;
//# sourceMappingURL=persona_validate.d.ts.map