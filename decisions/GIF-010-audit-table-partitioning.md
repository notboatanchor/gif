# GIF-010 — Audit Table Monthly Partitioning

**Status:** Accepted  
**Date:** 2026-04-04

## Decision

`audit_events` uses PostgreSQL declarative range partitioning on `occurred_at`, monthly interval. Partitions are provisioned before the month they cover. Application code (`logAuditEvent()`) is unaffected — INSERTs route to the correct partition automatically.

## Context

The audit trail is the primary governance record and the table most likely to grow without bound over a deployment's lifetime. Unpartitioned, time-range queries degrade as the table grows, and row-level retention enforcement becomes operationally impractical at scale.

## Rationale

**Partitioning a populated table is significantly more complex than partitioning from the start.** Adopting partitioning retroactively requires a table rebuild under load — a high-risk, high-downtime operation. Early partitioning eliminates that risk entirely.

**Partition pruning improves query performance automatically for time-range queries.** Compliance reports and retention scans operate on bounded partition sets without query changes. The query planner excludes partitions outside the requested time range transparently.

**Retention is implemented as partition drop, not row deletion.** Old partitions are dropped when the retention window closes. Dropping a partition is an instantaneous metadata operation; row-by-row deletion at scale is not. The `retention_policy` on personas activates this mechanism — each persona declares its retention window, and a conservative-wins rule applies across all personas with events in a partition. A partition is not dropped until all personas whose events appear in it have passed their retention window.

## Consequences

New partitions must be provisioned before the month they cover. A maintenance gap — a month with no pre-provisioned partition — will cause INSERT failures for that month's audit records. See `docs/ops-runbook-audit-retention.md` for the monthly maintenance procedure. Partition provisioning should be automated as part of deployment operations.
