import { Persona } from '../persona.js';
export interface WebSearchArgs {
    persona_id: string;
    query: string;
    max_results: number;
}
export interface SearchResult {
    url: string;
    title: string;
    content: string;
    published_at: string | null;
    engine: string;
    engines: string[];
}
export interface WebSearchResponse {
    query: string;
    number_of_results: number;
    results: SearchResult[];
}
export declare function executeWebSearch(args: WebSearchArgs, persona: Persona, sessionId: string): Promise<{
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
}>;
//# sourceMappingURL=web_search.d.ts.map