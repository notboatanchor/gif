import { Persona } from '../persona.js';
import type { ToolHandler } from './types.js';
export interface PersonaRevokeArgs {
    persona_id: string;
    target_persona_id: string;
    reason: string;
    revoked_by: string;
}
export declare function executePersonaRevoke(args: PersonaRevokeArgs, persona: Persona, sessionId: string): Promise<{
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
}>;
export declare const handler: ToolHandler;
//# sourceMappingURL=persona_revoke.d.ts.map