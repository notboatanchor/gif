import { Persona } from '../persona.js';
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
//# sourceMappingURL=persona_revoke.d.ts.map