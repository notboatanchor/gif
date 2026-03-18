import { Persona } from '../persona.js';
import type { ToolHandler } from './types.js';
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
export declare const handler: ToolHandler;
//# sourceMappingURL=db_read.d.ts.map