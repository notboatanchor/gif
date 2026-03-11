// src/tools/web_search.ts
// =============================================================================
// web_search tool handler
// Wraps SearXNG self-hosted search with persona scope validation.
//
// Scope checks performed before execution:
//   1. permitted_actions must include 'search'
//   2. permitted_sources, if defined, must include 'searxng'
//
// Scope violations are logged to scope_violations table and returned
// as structured errors. No search executes on a scope violation.
//
// ADR-008: MCP server as the AI tool interface layer
// ADR-009: Persona-based permissions as infrastructure
// =============================================================================

import { Persona, logScopeViolation } from '../persona.js';

const SEARXNG_URL = process.env.SEARXNG_URL || 'http://searxng:8080';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface WebSearchArgs {
  persona_id:  string;
  query:       string;
  max_results: number;
}

export interface SearchResult {
  url:           string;
  title:         string;
  content:       string;
  published_at:  string | null;
  engine:        string;
  engines:       string[];
}

export interface WebSearchResponse {
  query:            string;
  number_of_results: number;
  results:          SearchResult[];
}

// SearXNG raw result shape — fields may be absent
interface SearXNGResult {
  url:            string;
  title:          string;
  content?:       string;
  publishedDate?: string;
  engine?:        string;
  engines?:       string[];
}

interface SearXNGResponse {
  query:            string;
  number_of_results: number;
  results:          SearXNGResult[];
}

// ----------------------------------------------------------------------------
// Scope validation
// Returns null if valid, or a rejection message if not.
// Caller is responsible for logging the violation before returning the error.
// ----------------------------------------------------------------------------

function checkWebSearchScope(persona: Persona): string | null {
  const scope = persona.scope_definition;

  // Check permitted_actions — must include 'search' if the field is present.
  // Absence of permitted_actions means no action restrictions declared.
  if (scope.permitted_actions && scope.permitted_actions.length > 0) {
    if (!scope.permitted_actions.includes('search')) {
      return `Persona ${persona.persona_id} does not have 'search' in permitted_actions`;
    }
  }

  // Check permitted_sources — must include 'searxng' if the field is present.
  // Absence of permitted_sources means no source restrictions declared.
  if (scope.permitted_sources && scope.permitted_sources.length > 0) {
    if (!scope.permitted_sources.includes('searxng')) {
      return `Persona ${persona.persona_id} does not have 'searxng' in permitted_sources`;
    }
  }

  return null;
}

// ----------------------------------------------------------------------------
// executeWebSearch()
// Called from the tool router in index.ts after persona validation passes.
// Persona record is passed in — no second DB round trip needed.
// ----------------------------------------------------------------------------

export async function executeWebSearch(
  args: WebSearchArgs,
  persona: Persona
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {

  // Scope check
  const scopeError = checkWebSearchScope(persona);
  if (scopeError) {
    await logScopeViolation({
      personaId:       args.persona_id,
      attemptedAction: 'search',
      toolName:        'web_search',
      context:         { query: args.query, max_results: args.max_results },
    });
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: scopeError }) }],
      isError: true,
    };
  }

  // Execute search against SearXNG
  let searxngData: SearXNGResponse;

  try {
    const params = new URLSearchParams({
      q:       args.query,
      format:  'json',
      pageno:  '1',
    });

    const response = await fetch(`${SEARXNG_URL}/search?${params.toString()}`, {
      method:  'GET',
      headers: { 'Accept': 'application/json' },
      signal:  AbortSignal.timeout(15000), // 15s timeout
    });

    if (!response.ok) {
      throw new Error(`SearXNG returned HTTP ${response.status}`);
    }

    searxngData = await response.json() as SearXNGResponse;

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[web_search] SearXNG request failed:`, message);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: `Search failed: ${message}` }) }],
      isError: true,
    };
  }

  // Normalise and cap results at max_results
  const results: SearchResult[] = searxngData.results
    .slice(0, args.max_results)
    .map((r: SearXNGResult) => ({
      url:          r.url,
      title:        r.title,
      content:      r.content     ?? '',
      published_at: r.publishedDate ?? null,
      engine:       r.engine      ?? '',
      engines:      r.engines     ?? [],
    }));

  const responsePayload: WebSearchResponse = {
    query:             args.query,
    number_of_results: searxngData.number_of_results,
    results,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(responsePayload) }],
  };
}
