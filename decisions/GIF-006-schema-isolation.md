# GIF-006 — Schema Isolation

**Status:** Accepted  
**Date:** 2026-04-04

## Decision

The `gif` schema owns all gif objects. `gif_admin` owns the schema and runs all migrations. Per-adopter application users carry only documented minimum grants on `gif.*`. The schema name `gif` is fixed in v1.

## Context

gif is designed to coexist with adopter schemas in the same PostgreSQL instance. A shared-instance deployment requires clear isolation so that an adopter application credential cannot access gif internals beyond what is required, and gif migrations do not interfere with adopter schemas.

## Required Grants

A conforming adopter application user (`gif_app` or equivalent) requires the following grants and no more:

| Object | Privileges |
|--------|-----------|
| `gif` schema | USAGE |
| `gif.personas` | SELECT, INSERT |
| `gif.audit_events` | SELECT, INSERT |
| `gif.audit_events_*` partitions | SELECT, INSERT (REVOKE UPDATE explicitly) |
| `gif.scope_violations` | SELECT, INSERT |
| `gif.sessions` | SELECT, INSERT, UPDATE |
| `gif.tool_registry` | SELECT |
| `gif.combination_policies` | SELECT |
| `gif.revocation_log` | SELECT, INSERT |
| `gif.schema_migrations` | SELECT, INSERT |

INSERT-only RLS policies apply to every user granted INSERT on audit tables. This is not optional and must be explicitly applied per user.

## Rationale

**Schema-level isolation** enables gif to coexist with adopter schemas in the same PostgreSQL instance. An adopter application user receives `gif.*` required grants plus grants on their own schema. The two grant sets do not overlap.

**`gif_admin` as a portable credential pattern.** Any adopter creates this role to deploy gif migrations. Role names are fixed framework internals, analogous to function names in a package. They are not configurable to avoid documentation drift between what the migration scripts expect and what the adopter has provisioned.

**Single database; persona identity travels as a parameter.** Concurrent users under different personas are fully supported. Persona identity is passed as a `persona_id` parameter on tool calls — it is never expressed as a database connection identity. This means a single connection pool can serve multiple concurrent personas without connection-per-persona overhead.

## Consequences

gif is compatible with AWS RDS, GCP Cloud SQL, Azure PostgreSQL, and Supabase. No SECURITY DEFINER functions rely on superuser privilege at runtime — they rely on table ownership. Postgres superuser is needed only for initial bootstrap. Adopters deploying to managed PostgreSQL services must provision the `gif_admin` role and grant schema ownership before running migrations.
