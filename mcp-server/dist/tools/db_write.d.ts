import { Persona } from '../persona.js';
export interface DbWriteArgs {
    persona_id: string;
    table: string;
    record: string;
}
export declare function executeDbWrite(args: DbWriteArgs, persona: Persona, sessionId: string): Promise<{
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
}>;
//# sourceMappingURL=db_write.d.ts.map