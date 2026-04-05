# GIF-014 — persona_id Bearer Token Model

**Status:** Accepted  
**Date:** 2026-04-05

## Decision

`persona_id` is accepted as a bearer token at v0.1. GIF does not structurally verify at runtime that the AI making tool calls is the authorized holder of the `persona_id` it presents. This is a deliberate, documented constraint — not an oversight. Structural session binding (Option 1) is identified as a contributor project for adopters requiring high-assurance runtime authorization proof.

## Context

At runtime, every tool call presents a `persona_id` as an argument. GIF validates that the persona exists, is active, is within temporal bounds, and has passed governance review. It does not verify that the calling process is the specific entity authorized to hold that persona.

The identity token mechanism (`_verifyIdentityBinding`) proves provisioning authorization — a human authorized the creation of this persona and its assignment to an AI. It does not prove runtime authorization — that the process currently making tool calls was the intended recipient of that assignment.

This was the subject of the Option 1 vs. Option 3 design discussion (2026-04-05, Session 10).

## Why the Bearer Token Model Is Acceptable at v0.1

**Enumeration is blocked.** `persona_id` UUIDs are not publicly accessible. The `personas` table is gated behind an explicit `admin_read` permission (not in `ALLOWED_READ_TABLES`). An AI cannot discover other personas' UUIDs through GIF's own tools.

**Provisioner accountability is structural.** Every persona has a named provisioning human in `user_persona_assignments`. If a `persona_id` is misused, there is a structural record of who authorized it and for what purpose.

**The audit trail is append-only.** Any misuse — including a misconfigured AI operating under the wrong persona — is recorded in full and cannot be altered. The governance value of accountability is preserved even when the wrong identity is in the record.

**Runtime identity is the adopter's obligation.** GIF-013 establishes that the responsible human ID must always be present in the audit trail, passed by the adopter on every invocation. This closes the accountability gap: even if the `persona_id` is wrong, the human accountable for the invocation is on record.

**The realistic threat is misconfiguration, not attack.** `persona_id` UUIDs are returned only to the provisioner. The realistic failure mode is copy-paste or configuration management error, not adversarial impersonation. The audit trail surfaces this; the provisioner is accountable for it.

## Mitigations in Place

- `admin_read` gate on `personas` table — prevents AI enumeration of persona UUIDs
- Identity token at provisioning — named human on record for every persona
- Append-only audit trail — full record of all actions, including misconfigured ones
- `invocation_context` attachment point — adopters pass responsible human ID on every invocation (GIF-013)
- `max_delegation_depth` — structurally limits delegation chain depth

## What Would Change This Decision

- Evidence that `persona_id` enumeration is possible through an attack surface not currently considered
- Regulated-industry deployment requirements that mandate cryptographic proof of runtime authorization (not just provisioner accountability)
- Multi-tenant deployments where different organizations' personas coexist in a single GIF instance, raising the consequences of cross-persona access

## Option 1 — Structural Session Binding (Contributor Project)

The alternative considered and deferred: at MCP session initialization, the AI presents its `assignment_id`. The server validates the assignment (active, not revoked, maps to the claimed persona), records the MCP session → persona binding, and rejects tool calls where `persona_id` does not match the session binding.

This provides a structural guarantee that Option 3 does not: the AI making calls is cryptographically linked to the authorized assignment, not just claiming a UUID.

This is the correct implementation for adopters with high-assurance runtime authorization requirements. It is not in GIF core at v0.1 because:
- The binding mechanism requires the AI's MCP client to be configured to present `assignment_id` at session init — an adopter integration requirement that varies by deployment
- The accountability gap it closes (misconfiguration, not attack) is adequately addressed by GIF-013's adopter obligations for general deployments
- Building it into GIF core before adopter deployment patterns are known risks building the wrong abstraction

**Extension points for a contributor implementation:** the `transports` map in `index.ts` (keyed by MCP session ID), `user_persona_assignments.assignment_id` (the persistent post-provisioning credential), and a new `session_bindings` table to record the MCP session → assignment → persona mapping in the audit record.

See CONTRIBUTING.md for the full project description.

## Consequences

- `persona_id` bearer token model is the accepted runtime authorization mechanism for v0.1
- Adopters must not assume GIF provides structural proof that the AI is the authorized holder of its persona
- This constraint must be prominently documented in adopter-facing documentation
- The `invocation_context` contract (see `docs/adopter-invocation-context.md`) is the primary mechanism for adopters to fulfill their runtime accountability obligations under GIF-013
