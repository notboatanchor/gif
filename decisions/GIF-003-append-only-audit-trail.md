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

## Update — canonical-form hash alignment (2026-06-04, migration 014)

The infrastructure-level tamper evidence flagged as roadmap above is now implemented in a vendor-neutral, tamper-evident audit-record canonical form:

- **Hash chain.** Migration 006 added a `BEFORE INSERT` trigger that computes `event_hash = sha256(preimage)` with `previous_hash` linking each row to the prior row in its month partition (`SECURITY DEFINER`, owned by `gif_admin`, never-throws). Migration 014 changes only *how the preimage is computed*: from a pipe-delimited string to a **sorted-key JSON canonical form (`gif-audit/1`)**. A freshly inserted row's `event_hash` is byte-identical to the vendor-neutral reference vectors and to a plain `sha256sum` of the same canonical record.
- **`purpose_declared` is now in the hashed preimage.** A privileged writer can no longer rewrite the declared governance reason for an action without breaking the chain — this closes a real integrity gap (the declared *why* is now tamper-evident, not just the *what*).
- **Canonical key mapping (no column renames).** The stored column `persona_id` maps to the canonical key `principal_id`; `invoked_by_persona_id` → `invoked_by_principal_id`. gif implements the `caller-governance` profile. Timestamps are millisecond RFC 3339 UTC (`…Z`).
- **Verification.** The read-only operator CLI `mcp-server/src/cli/verify_audit_chain.ts` recomputes and re-links the chain (and checks external anchors with `--check-anchors`). `canon_version` (`gif-audit/1`) is stamped per row; the verifier branches on it for forward-safety — a row written under a future canonical form is reported as *uncheckable*, never as tamper.
- **Normalization parity caveat.** Protected string fields are NFC-normalized and trimmed identically by the trigger and the verifier. The verifier additionally rejects control characters / over-length strings (per the canonical-form canonicalizer); the trigger does NFC + trim only, because audit logging must never throw (see above). For gif's controlled-vocabulary / `persona.purpose` inputs the two agree byte-for-byte; a value that trips the verifier's stricter check is surfaced as *uncheckable*, not tamper.
