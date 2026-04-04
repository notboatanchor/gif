# GIF-012 — Framework Boundary Principle

**Status:** Accepted  
**Date:** 2026-04-04

## Decision

gif owns the governance primitive — table structure, enforcement mechanism, audit surface. Adopters own the content — rows, registrations, domain configuration. gif ships with zero rows in `tool_registry` and `combination_policies`.

## Context

A governance framework that accumulates domain-specific logic becomes a product for a specific domain rather than infrastructure for any domain. The framework boundary must be explicit and enforceable as a decision criterion, not merely a convention.

## The Boundary Test

**Would an adopter outside this specific domain need this structure?** If yes, it belongs in gif. If no, it belongs in the adopter's schema.

## Rationale

The boundary test prevents gif from accumulating domain-specific logic that would fragment adopter use cases or require gif source modification for each deployment. The `tool_registry` and `combination_policies` pattern demonstrates the correct approach: gif defines the table and the mechanism; adopters register domain-specific content; the enforcement engine enforces whatever is registered. gif's behavior is determined by what adopters register, not by what gif hardcodes.

Extension pattern for entity types follows the same logic: gif defines core constraints in the schema; adopters extend via schema comments and application-layer validation. Hardcoded SQL constraints in gif migrations for adopter-specific entity types would fail the boundary test.

## What Adopters Own

- Tool registrations
- Persona definitions and purpose statements
- Combination policies
- Access type definitions
- `scope_definition` content

## What gif Owns

- The schema for all of the above
- The enforcement logic that reads it
- The audit record that captures it

## Consequences

Any proposal to add domain-specific content to gif migrations must pass the boundary test. gif schema changes are framework changes, not configuration. A migration that adds rows to `tool_registry` for a specific adopter's domain tools is a boundary violation. A migration that adds a column to `tool_registry` to support a new enforcement capability is a framework change and belongs in gif.
