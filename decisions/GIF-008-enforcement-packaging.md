# GIF-008 — Enforcement Packaging

**Status:** Accepted  
**Date:** 2026-04-04

## Decision

gif ships an importable enforcement package. Adopters build their own MCP server by importing `createEnforcement(pool)` and injecting their own `pg.Pool`. Tool dispatch is registry-driven. gif ships with zero domain tool registrations.

## Context

The enforcement mechanism must be distributable to adopter tool servers without requiring adopters to modify gif source or co-locate domain tools with gif internals. The boundary between gif's infrastructure and adopter domain logic must be structurally clear.

## Rationale

**IP boundary.** If adopter domain tools lived in the gif server, the boundary between gif's intellectual property and the adopter's domain logic would be structurally unclear. The importable package pattern makes the boundary explicit: gif owns the enforcement surface; adopters own the tools registered against it.

**Registry-driven dispatch.** The enforcement engine contains no knowledge of which specific tools exist. New tools are registered by adopters; the enforcement path does not change. gif enforces whatever is registered — it does not define it.

**Injected pool topology.** Adopters may use the same database as gif (separate schema), a separate database on the same server, or a separate server entirely. All topologies are supported without code changes. The adopter provides the pool; gif uses it.

## Tool Ownership Boundary

**Framework tools (owned by gif):** `persona_create`, `persona_list`, `persona_revoke`, `session_open`, `session_close`, `db_read`, `db_write`.

**Adopter tools (registered by adopters, enforced by gif):** anything in the adopter's domain. gif enforces them; gif does not define them.

## Consequences

Adopters do not modify gif source to add domain tools. Any proposal to add domain-specific tool implementations to gif fails the framework boundary test (see GIF-012). The `createEnforcement(pool)` interface is the stable integration surface — changes to it require a major version bump per GIF-007.
