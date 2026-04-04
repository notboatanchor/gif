# GIF-004 — Purpose Field Non-Nullable on Personas

**Status:** Accepted  
**Date:** 2026-04-04

## Decision

The `purpose` field on personas is non-nullable. A persona without declared purpose has no governance value in the audit trail.

## Context

The audit trail records what happened. The purpose field records why it was authorized. Governance requires both. Without a declared purpose, an audit record shows that persona X called tool Y — but provides no answer to the question every regulated deployment will eventually face: why was this persona created with this scope, and who authorized it for what reason?

## Rationale

The purpose field is the human-readable record of the authorization intent at the time the persona was created. Allowing null purpose would mean gif could be deployed and used to run tool calls against live systems with no declaration of why those actions were authorized. The audit trail would be structurally complete but semantically empty at the most important dimension. Governance requires that the record of what happened can be connected to a declared authorization rationale — not reconstructed after the fact, but captured at creation time.

## Consequences

Schema constraint enforced from v0.1.0. Every persona creation call must supply a purpose. Adopter tool servers must propagate purpose from the source of the authorization decision. A persona creation request without a purpose field is a schema validation error, not a runtime default.
