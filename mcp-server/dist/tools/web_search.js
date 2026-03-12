"use strict";
// src/tools/web_search.ts
// =============================================================================
// web_search tool handler
// Wraps SearXNG self-hosted search with persona scope validation.
//
// Scope checks performed before execution:
//   1. permitted_actions must include 'search'
//   2. permitted_sources, if defined, must include 'searxng'
//
// ADR-008: MCP server as the AI tool interface layer
// ADR-009: Persona-based permissions as infrastructure
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeWebSearch = executeWebSearch;
const persona_js_1 = require("../persona.js");
const SEARXNG_URL = process.env.SEARXNG_URL || 'http://searxng:8080';
// ----------------------------------------------------------------------------
// Scope validation
// ----------------------------------------------------------------------------
function checkWebSearchScope(persona) {
    const scope = persona.scope_definition;
    if (scope.permitted_actions && scope.permitted_actions.length > 0) {
        if (!scope.permitted_actions.includes('search')) {
            return `Persona ${persona.persona_id} does not have 'search' in permitted_actions`;
        }
    }
    if (scope.permitted_sources && scope.permitted_sources.length > 0) {
        if (!scope.permitted_sources.includes('searxng')) {
            return `Persona ${persona.persona_id} does not have 'searxng' in permitted_sources`;
        }
    }
    return null;
}
// ----------------------------------------------------------------------------
// executeWebSearch()
// sessionId is required for scope violation logging.
// ----------------------------------------------------------------------------
async function executeWebSearch(args, persona, sessionId) {
    // Scope check
    const scopeError = checkWebSearchScope(persona);
    if (scopeError) {
        await (0, persona_js_1.logScopeViolation)({
            personaId: args.persona_id,
            sessionId,
            attemptedAction: 'search',
            toolName: 'web_search',
            context: { query: args.query, max_results: args.max_results },
        });
        return {
            content: [{ type: 'text', text: JSON.stringify({ error: scopeError }) }],
            isError: true,
        };
    }
    // Execute search
    let searxngData;
    try {
        const params = new URLSearchParams({
            q: args.query,
            format: 'json',
            pageno: '1',
        });
        const response = await fetch(`${SEARXNG_URL}/search?${params.toString()}`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) {
            throw new Error(`SearXNG returned HTTP ${response.status}`);
        }
        searxngData = await response.json();
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[web_search] SearXNG request failed:`, message);
        return {
            content: [{ type: 'text', text: JSON.stringify({ error: `Search failed: ${message}` }) }],
            isError: true,
        };
    }
    const results = searxngData.results
        .slice(0, args.max_results)
        .map((r) => ({
        url: r.url,
        title: r.title,
        content: r.content ?? '',
        published_at: r.publishedDate ?? null,
        engine: r.engine ?? '',
        engines: r.engines ?? [],
    }));
    return {
        content: [{ type: 'text', text: JSON.stringify({
                    query: args.query,
                    number_of_results: searxngData.number_of_results,
                    results,
                }) }],
    };
}
//# sourceMappingURL=web_search.js.map