# ADR-002: Migrate MCP Transport from SSE to Streamable HTTP

**Status:** Accepted  
**Date:** 2026-04-04

## Context

gif's MCP server currently uses the SSE (Server-Sent Events) transport from the
`@modelcontextprotocol/sdk`. This transport was the original MCP wire protocol:
clients open a persistent SSE connection to receive messages and POST requests
to a separate `/message` endpoint.

The MCP specification has deprecated SSE transport in favor of **Streamable HTTP**
— a cleaner bidirectional transport over a single HTTP endpoint. The
`@modelcontextprotocol/sdk` ships `StreamableHTTPServerTransport` as the current
implementation and marks `SSEServerTransport` as legacy.

gif's current server (`mcp-server/src/index.ts`) suppresses two lint warnings
under `@typescript-eslint/no-deprecated` for `Server` and `SSEServerTransport`
precisely because they are flagged as deprecated by the SDK. Those suppressions
are a known debt item, not a permanent decision.

Shipping a public open source release on deprecated transport would be a poor
first impression for infrastructure that positions itself as current, trustworthy
governance infrastructure.

## Decision

Migrate the gif MCP server from SSE transport to Streamable HTTP transport before
the first public open source release.

**Server changes:**
- Replace `SSEServerTransport` with `StreamableHTTPServerTransport` in `index.ts`
- Replace the `/sse` and `/message` endpoint pair with a single `/mcp` endpoint
  (or the SDK default — follow SDK conventions)
- Remove the two `@ts-expect-error` / `eslint-disable` suppressions for deprecated symbols
- Update server startup log to reflect the new endpoint URL

**Test changes:**
- Replace `SSEClientTransport` with `StreamableHTTPClientTransport` in `test_mcp.mjs`
- Update the transport URL accordingly

**Documentation changes:**
- Update `docker-compose.yml` comments that reference `/sse`
- Update `docs/architecture-diagrams.md` if any diagram references the SSE endpoint
- Update any runbooks or operator docs that reference `/sse`

## Consequences

**Positive:**
- gif ships on the current MCP transport standard
- Eliminates two suppressed deprecation warnings — lint is clean without exceptions
- Adopters building on gif start from a current foundation; no need to migrate
  transport in their own stacks later

**Negative:**
- Any existing client connected via the old SSE transport (e.g., Claude Desktop
  config pointing at `/sse`) will break and need to be updated. This is acceptable
  pre-public-release — there are no external adopters yet.
- Streamable HTTP transport behavior (session handling, reconnection) differs from
  SSE and requires verification against the full integration test suite.

## Alternatives Considered

**Keep SSE until SDK forces removal.** Rejected — the deprecation is current, the
migration path is clear, and the cost of doing this post-publish is higher
(adopters would need to update their client configs).

**Support both transports in parallel.** Rejected — adds complexity for no benefit
at this stage. gif has no external adopters yet. A clean cut is the right call.
