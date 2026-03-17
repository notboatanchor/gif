import { Persona } from '../persona.js';
export interface PersonaCreateArgs {
    persona_id: string;
    issuing_entity: string;
    purpose: string;
    created_by: string;
    scope_definition: string;
    valid_until: string;
    valid_from?: string;
    max_delegation_depth?: number;
    parent_persona_id?: string;
}
export declare function executePersonaCreate(args: PersonaCreateArgs, persona: Persona, sessionId: string): Promise<{
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
}>;
//# sourceMappingURL=persona_create.d.ts.map