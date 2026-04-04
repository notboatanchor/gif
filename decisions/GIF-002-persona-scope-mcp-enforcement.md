# GIF-002 — Persona Scope Enforced at MCP Layer

**Status:** Accepted  
**Date:** 2026-04-04

## Decision

Persona scope validation happens at the MCP layer before tool execution — not in application code, not at the database layer. The AI is a scoped executor of rights the consumer already legitimately holds. No ambient authority.

## Context

The "permissions as afterthought" failure mode — capability built first, governance added later — is costly and creates accountability gaps. When enforcement is distributed across application code and database constraints, it is possible to bypass one layer while the other fails silently. Building enforcement as infrastructure from the start, at the only architecturally correct chokepoint, prevents this pattern from taking hold.

Enforcement at the application layer is too early and too shallow — the AI can route around it, and the enforcement has no visibility into the actual tool parameters. Enforcement at the database layer is too late — the intent has already been acted on. Enforcement at the MCP layer intercepts every tool call at the point where the AI's intent is fully legible and still preventable.

## Rationale

- Application-layer enforcement is bypassable. Database-layer enforcement cannot express persona-scoped rules without schema coupling that entangles gif's schema with adopter application logic.
- The MCP layer is the only chokepoint that is consistently present for every tool call, regardless of which tool is invoked or which application path initiated the request.
- Aggregation risk is mitigated at the MCP layer because the enforcement point has visibility into the full request context — persona identity, session state, tool parameters — before execution.

## User-to-Persona Binding Invariants

gif defines five invariants for a conforming user-to-persona binding implementation:

1. **Assignment is admin-controlled.** No self-assignment. Human administrators create and revoke personas. AI agents operate under them.
2. **Binding is auditable.** Assignment events are recorded in the audit trail.
3. **Delegation hierarchy is respected.** A user cannot assign a persona with broader scope than their own.
4. **Revocation is independently applicable.** Persona revocation and assignment revocation are distinct operations.
5. **External identity is the integration point.** gif accepts an `external_user_id` parameter; adopters satisfy it using their own identity infrastructure.

Full user-to-persona binding implementation is part of the compliance hardening roadmap. The invariants are decided; the enforcement mechanism is deferred.

## Consequences

Enforcement logic must not be duplicated in application code. No tool handler may bypass the MCP enforcement point. Persona scope is a framework primitive, not an application concern. Adopters who build application-layer permission checks in addition to MCP enforcement are adding redundancy without replacing the authoritative enforcement point.
