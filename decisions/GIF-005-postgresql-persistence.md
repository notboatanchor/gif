# GIF-005 — PostgreSQL as Sole Persistence Layer

**Status:** Accepted  
**Date:** 2026-04-04

## Decision

PostgreSQL is the sole persistence layer for gif. No other data stores.

## Context

gif requires structural immutability guarantees for the audit trail, persona-scoped access control, and flexible schema structures for scope definitions and combination policies. The persistence layer choice is not incidental — it is load-bearing for the governance guarantees gif provides.

## Rationale

**Row-level security is the mechanism that enforces append-only audit integrity.** INSERT-only database permissions on audit tables are enforced through PostgreSQL's role and RLS model. This is not a preference for PostgreSQL over alternatives — it is why PostgreSQL is required. The structural audit guarantee described in GIF-003 is implemented through this mechanism.

**Data sovereignty.** Audit logs and persona definitions may contain sensitive governance data. Operators must be able to run gif without exfiltrating data to a third-party service. PostgreSQL is self-hosted infrastructure that operates entirely within the adopter's network boundary. This matters for regulated industries — healthcare, finance, defense — where data residency requirements preclude third-party SaaS data stores for governance records.

**JSONB support.** `scope_definition` and `combination_policies` structures require flexible document-style storage without a separate document store. PostgreSQL's JSONB support handles this natively, eliminating the operational and complexity cost of a polyglot persistence layer.

## Consequences

gif does not support Redis, MongoDB, or any other store alongside PostgreSQL. Adopters do not need to provision additional infrastructure beyond a PostgreSQL instance. gif is compatible with managed PostgreSQL services — AWS RDS, GCP Cloud SQL, Azure Database for PostgreSQL, Supabase — as the required constraints rely on table ownership and standard role grants, not superuser-only features at runtime.
