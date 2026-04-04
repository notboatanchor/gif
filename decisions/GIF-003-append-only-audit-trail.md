# GIF-003 — Append-Only Audit Trail

**Status:** Accepted  
**Date:** 2026-04-04

## Decision

`audit_events` and all audit-related tables use INSERT-only database permissions. The append-only constraint is structural — enforced at the database permission level — not policy. `logAuditEvent()` and `logScopeViolation()` catch all errors internally and never throw.

## Context

An audit trail that can be modified provides no accountability guarantee. The value of an audit record is its immutability. If an application credential can UPDATE or DELETE audit records, the trail can be altered after the fact to remove evidence of a scope violation, suppress a tool call record, or alter a parameter value. This defeats the governance objective entirely.

## Rationale

**Structural constraint vs. policy.** A policy can be changed by an authorized actor at runtime. A structural constraint — INSERT-only database permissions on the application role — cannot be violated without revoking the database role and replacing it. This distinction matters for regulatory reliance: a policy-based immutability claim ("we promise not to change the logs") is weaker than a structural one that requires an out-of-band infrastructure action to circumvent.

**Honest scope of the guarantee.** INSERT-only database permissions stop application-layer tampering. They do not stop a database administrator with direct infrastructure access, a backup-restore cycle, or a compromised superuser credential. These are real attack surfaces. The compliance hardening roadmap addresses them through cryptographic log signing — hash chains linking audit records with periodic external timestamping — such that any gap, reordering, or modification is detectable. Until that is implemented, gif's audit trail is accurately described as structurally protected at the application layer, with infrastructure-level tamper evidence on the roadmap.

**Audit failures must never mask tool responses.** A logging failure is not a reason to deny a tool call. Silent degradation in audit logging is preferable to noisy failure that disrupts operations and creates an incentive to disable the audit path. `logAuditEvent()` and `logScopeViolation()` catch all errors internally.

## Behavioral Reporting

Persona-scoped audit data enables process flow documentation by role across all sessions without individual user identification. Because audit records are keyed to persona identity rather than user identity, the audit trail can answer "what does this persona class do" — which tools are invoked, in what order, with what outcomes — without answering "what did this specific user do." This is a governance artifact that emerges from correct schema design, not a reporting feature added later.

## Consequences

`audit_events` is the authoritative governance record. Compliance reporting, behavioral analysis, and regulatory audit all build from this table. Adopters must not grant UPDATE or DELETE on audit tables to application users. The schema migration that creates `audit_events` and its partitions must include the INSERT-only permission grants as a non-optional step.
