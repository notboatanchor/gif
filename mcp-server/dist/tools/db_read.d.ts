import { Persona } from '../persona.js';
export interface DbReadArgs {
    persona_id: string;
    table: string;
    filters?: string;
    limit: number;
}
export declare function executeDbRead(args: DbReadArgs, persona: Persona, sessionId: string): Promise<{
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
}>;
//# sourceMappingURL=db_read.d.ts.map