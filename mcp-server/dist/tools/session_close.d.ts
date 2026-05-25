import type { Persona } from '../persona.js';
import type { ToolHandler, ToolResult } from './types.js';
export interface SessionCloseArgs {
    persona_id: string;
    gif_session_id: string;
}
export declare function executeSessionClose(args: SessionCloseArgs, persona: Persona, _sessionId: string): Promise<ToolResult>;
export declare const handler: ToolHandler;
//# sourceMappingURL=session_close.d.ts.map