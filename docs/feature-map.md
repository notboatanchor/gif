# gif feature map
<!-- feature-map-synced-at: 65b85d250ae384f0188ac21c5843b124366a77d9 -->
<!-- feature-map-covers: mcp-server/src/**/*.ts; schema/*.sql; ops/*.sql -->
Last synced: 2026-11-06 at `65b85d2`. Kept current by the docs-sync skill. Check: `python3 scripts/check_feature_map.py`. Format: `_planning/feature-map-format.md`.

## How to use this map

- Find the feature in the index, then go to its section. `ADR-NNN` and `GIF-NNN` refer to `decisions/`.
- gif has no UI and one MCP endpoint: "API" lines name the MCP tool, its required arguments and its handler.
- "Who" is the `permitted_actions` value a persona needs in its `scope_definition`.
- The "Verify" line is the minimum check after a change to that feature.
- When a path in the map is wrong, fix the map in the same commit.

## Index

| Feature | Area | One line | Section |
|---|---|---|---|
| Audit chain verification | Audit | Operator CLI recomputes and re-links the audit hash chain | [Audit chain verification](#audit-chain-verification) |
| Audit retention and partition retirement | Audit | Legal holds and governed retirement of aged audit partitions | [Audit retention and partition retirement](#audit-retention-and-partition-retirement) |
| Audit trail and hash chain | Audit | Append-only audit events, scope violations and read log, hash-chained per month | [Audit trail and hash chain](#audit-trail-and-hash-chain) |
| Combination policies | Enforcement | Blocks or flags a session that combines a sensitive set of sources | [Combination policies](#combination-policies) |
| Enforcement package (`gif-enforcement`) | Enforcement | `createEnforcement(pool)`, the adopter import point | [Enforcement package](#enforcement-package-gif-enforcement) |
| MCP dispatch and transport | Enforcement | `/mcp` and `/health`, Origin guard, persona and session gates, tool registry | [MCP dispatch and transport](#mcp-dispatch-and-transport) |
| Identity binding | Personas | HMAC identity tokens tie each new persona to a verified human | [Identity binding](#identity-binding) |
| Persona provisioning and revocation | Personas | Create, validate and revoke personas with delegation limits | [Persona provisioning and revocation](#persona-provisioning-and-revocation) |
| Governance sessions | Sessions | Mint, validate and close `gif_session_id` handles with TTL | [Governance sessions](#governance-sessions) |
| Governed data access (`db_read`, `db_write`) | Tools | Reference adopter tools: allowlisted, scope-checked table read and insert | [Governed data access](#governed-data-access-db_read-db_write) |
| Schema install and migrations | Platform | Bootstrap, schema separation and migration records | [Schema install and migrations](#schema-install-and-migrations) |

## Audit

### Audit trail and hash chain
The system records every governed tool call, scope violation and audit-class read in INSERT-only tables, and a trigger hash-chains each audit event per month partition.

- API: no tool of its own. Written by the dispatcher (`mcp-server/src/index.ts`, `tools/call` handler, `finally` block) and in-handler by `session_start`, `session_close`, `db_read`, `db_write`, `persona_create`, `persona_revoke`.
- Services: `mcp-server/src/enforcement.ts` (`_logAuditEvent`, `_logScopeViolation`, `_logAuditRead`; none of them throw); `mcp-server/src/session.ts` re-exports `logAuditEvent`; `mcp-server/src/persona.ts` re-exports `logScopeViolation`, `logAuditRead`
- Data: `gif.audit_events` (monthly partitions), `gif.scope_violations` (`schema/001_gif_core.sql`, `schema/002_gif_core.sql`); hash chain trigger and `gif.audit_chain_anchors` (`schema/006_audit_hash_chain.sql`); canonical JSON forms (`schema/014_audit_canonical_json.sql`, `schema/015_audit_canonical_json_v2.sql`, stamps `gif-audit/2`); per-partition write serialization via `gif.audit_chain_locks` (`schema/016_audit_chain_concurrency.sql`); `gif.audit_read_log` (`schema/008_audit_read_log.sql`)
- Tests: `mcp-server/test_audit_trail.mjs` (UPDATE/DELETE as `gif_app` must fail), `mcp-server/test_hash_chain.mjs`, `mcp-server/test_audit_chain_concurrency.mjs`, `mcp-server/test_read_log.mjs`, `mcp-server/test_shutdown_drain.mjs`, `mcp-server/conformance/c4_audit_emission.mjs`
- Docs: GIF-003, GIF-010, GIF-022 §C4
- Verify: `npm run vectors` (from `mcp-server/`), then `./scripts/test-local.sh`
- Watch: a change to canonicalization must update all four implementations together (CLAUDE.md "Audit canonical form is byte-identical across all four implementations")

### Audit chain verification
An operator runs a read-only CLI that walks the audit partitions, recomputes each SHA-256 and reports mismatches and chain breaks.

- Who: operator with database access (not an MCP tool, GIF-022)
- API: `node dist/cli/verify_audit_chain.js [--check-anchors] [--json]` -> `mcp-server/src/cli/verify_audit_chain.ts`
- Services: `mcp-server/src/audit/verify-core.ts` (`normalizeString`, `canonicalize`, `buildBody`, `buildBodyV2`, `recomputeHash`, `verifyPartition`, `verifyAnchors`, `verifyChain`)
- Data: reads `gif.audit_events`, `gif.audit_chain_anchors`
- Settings: `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`
- Tests: `mcp-server/test_verify_core.mjs`, `mcp-server/test_chain_verifier.mjs`, `mcp-server/test_normalization_rejection.mjs`, `mcp-server/test_verify_integrity_e2e.mjs`; vectors under `mcp-server/conformance/audit-record-contract/` (`npm run vectors`)
- Docs: GIF-003, `docs/runbooks/adopter/upgrade-path.md`
- Verify: `npm run vectors` and `node test_verify_core.mjs` (from `mcp-server/`)
- Watch: vectors are synced verbatim from `notboatanchor/audit-record-contract`; never edit the local copy (CLAUDE.md)

### Audit retention and partition retirement
An operator places legal holds and retires aged monthly audit partitions through a governed stored procedure that logs each retirement.

- Who: `gif_admin` only; the procedure is denied to application users (`schema/009_retention_lifecycle.sql`)
- API: `CALL gif.retire_partition(...)` -> `schema/009_retention_lifecycle.sql`; eligibility report `ops/retire_audit_partitions.sql`
- Data: `gif.retention_holds` (`schema/009_retention_lifecycle.sql`); `gif.erasure_log` (`schema/003_gif_erasure_log.sql`); retention policy is `scope_definition->>'retention_policy'` on `gif.personas`
- Tests: `mcp-server/test_retention.mjs`
- Docs: `docs/ops-runbook-audit-retention.md`
- Verify: `node test_retention.mjs` (from `mcp-server/`, stack up)

## Enforcement

### MCP dispatch and transport
The server answers MCP over Streamable HTTP, rejects bad Origins, validates the persona and the session handle, then dispatches to the registered tool handler.

- API: `POST /mcp` (MCP `tools/list`, `tools/call`) -> `mcp-server/src/index.ts:createServer`; `GET /health` -> `mcp-server/src/index.ts` (HTTP router); any other path answers 404. Route list confirmed on the running app at `65b85d2` (`/health` 200, `/other` 404, `/mcp` with a foreign Origin 403).
- Services: `mcp-server/src/tools/registry.ts` (`TOOL_REGISTRY`, the adopter extension point); `mcp-server/src/tools/types.ts` (`ToolHandler`, `skipSession`, `auditMetadata`); `mcp-server/src/tools/arg-guards.ts` (`findMissingRequiredArg` = protocol `InvalidParams`, no audit; `nonEmptyStringArgError`, `jsonObjectArgError` = audited value guards); `mcp-server/src/origin-allowlist.ts` (`parseAllowedOrigins`); `mcp-server/src/persona.ts` (`validatePersona` re-export)
- Settings: `PORT` (default 3100), `GIF_ALLOWED_ORIGINS` (default localhost, 127.0.0.1, [::1]), `GIF_SHUTDOWN_TIMEOUT_SECONDS` (default 8), `GIF_SESSION_TTL_SECONDS`
- Tests: `mcp-server/test_mcp.mjs`, `mcp-server/test_origin_validation.mjs`, `mcp-server/test_input_guards.mjs`, `mcp-server/test_shutdown_drain.mjs`, `mcp-server/conformance/c2_dispatch_validation.mjs`
- Docs: ADR-002, GIF-001, GIF-009, GIF-019, GIF-022 §C2.7; `docs/runbooks/adopter/production-deployment.md` (Host and body size belong to the proxy)
- Verify: `npm run typecheck && npm run lint && npm run build` (from `mcp-server/`), then `./scripts/test-local.sh`
- Watch: do not add audit emission to the protocol rejection path or Host validation in gif (CLAUDE.md non-negotiables)

### Enforcement package (`gif-enforcement`)
Adopters import `createEnforcement` and inject their own pool to get gif's enforcement functions without modifying gif source.

- API: `createEnforcement(pool)` -> `mcp-server/src/enforcement.ts` returns `validatePersona`, `createSession`, `closeSession`, `validateSessionHandle`, `logAuditEvent`, `logScopeViolation`, `verifyIdentityBinding`, `logAuditRead`, `checkCombinationPolicies`. Package export `.` -> `dist/enforcement.js` (`mcp-server/package.json`).
- Services: `mcp-server/src/enforcement_instance.ts` (gif's own instance on the `gif_app` pool); `mcp-server/src/db.ts` (pool)
- Settings: `PGHOST`/`POSTGRES_HOST`, `PGPORT`/`POSTGRES_PORT`, `PGUSER`/`POSTGRES_USER`, `PGPASSWORD`/`POSTGRES_PASSWORD`, `PGDATABASE`/`POSTGRES_DB`
- Tests: `mcp-server/test_combination_policies.mjs`, `mcp-server/test_identity_secret_floor.mjs` (import `dist/enforcement.js` directly)
- Docs: GIF-007, GIF-008, GIF-012; `docs/adopter-invocation-context.md`
- Verify: `npm run build` and the CI step "dist/ in sync with src/"
- Watch: `dist/` is tracked; rebuild and commit it with every `src/` change (`.gitignore` comment)

### Combination policies
Before a tool runs, an adopter checks whether the session's accumulated sources plus the incoming ones match an active policy, and blocks or flags the call.

- Who: adopter tool servers; gif's own tools do not call it (`codegraph callers checkCombinationPolicies` at `65b85d2`: only `createEnforcement`)
- API: `checkCombinationPolicies({ sessionId, personaId, incomingSourceRefs })` -> `mcp-server/src/enforcement.ts:_checkCombinationPolicies` (fails closed on DB error)
- Data: `gif.combination_policies`, `gif.enforcement_action`, FK from `gif.personas.combination_policy_ref` (`schema/010_combination_policies.sql`); reads `gif.audit_events.sources_touched`
- Tests: `mcp-server/test_combination_policies.mjs`, `mcp-server/conformance/c5_combination_scoping.mjs`
- Docs: GIF-011
- Verify: `node test_combination_policies.mjs` (from `mcp-server/`, stack up)

## Personas

### Persona provisioning and revocation
A managing persona creates child personas within its own scope and delegation depth, and revokes personas, closing their open sessions in the same transaction.

- Who: `manage_personas` for `persona_create` and `persona_revoke`; any active persona for `persona_validate`
- API: tool `persona_create` (required `persona_id`, `gif_session_id`, `issuing_entity`, `purpose`, `created_by`, `scope_definition`, `valid_until`, `identity_token`) -> `mcp-server/src/tools/persona_create.ts:executePersonaCreate`; tool `persona_revoke` (required `persona_id`, `gif_session_id`, `target_persona_id`, `reason`, `revoked_by`) -> `mcp-server/src/tools/persona_revoke.ts:executePersonaRevoke`; tool `persona_validate` (required `persona_id`, `skipSession`) -> `mcp-server/src/tools/persona_validate.ts:executePersonaValidate`
- Services: `mcp-server/src/enforcement.ts:_validatePersona` (status, temporal bounds, `governance_review_status` allowlist `auto_approved`/`approved`)
- Data: `gif.personas`, `gif.delegation_chain`, `gif.revocation_log` (`schema/001_gif_core.sql`, `schema/002_gif_core.sql`); writes audit events with `event_type` `persona_create` / `persona_revoke`
- Tests: `mcp-server/test_delegation.mjs`, `mcp-server/test_persona_transactions.mjs`, `mcp-server/conformance/c6_identity_gates.mjs`, `mcp-server/conformance/c2_dispatch_validation.mjs`
- Docs: GIF-002, GIF-004, GIF-022 §C6
- Verify: `node test_delegation.mjs && node test_persona_transactions.mjs` (from `mcp-server/`, stack up)
- Watch: `purpose` stays non-nullable and `personas` stays behind `admin_read` (CLAUDE.md non-negotiables)

### Identity binding
A human admin issues a short-lived HMAC token for a user-to-persona assignment, and `persona_create` verifies and consumes it once.

- Who: human admin with `IDENTITY_HMAC_SECRET` (issuer); `persona_create` (verifier)
- API: `npx ts-node src/cli/issue_identity_token.ts --assignment-id <id>` -> `mcp-server/src/cli/issue_identity_token.ts`; verification `mcp-server/src/enforcement.ts:_verifyIdentityBinding` (15-minute token age, one-way `token_consumed`)
- Services: `mcp-server/src/identity-secret.ts` (`identitySecretProblem`, `IDENTITY_HMAC_SECRET_MIN_BYTES` = 32; rejects the `.env.example` placeholder); startup check in `mcp-server/src/index.ts`
- Data: `gif.user_persona_assignments` (`schema/002_gif_core.sql`, `schema/007_identity_binding.sql`)
- Settings: `IDENTITY_HMAC_SECRET`
- Tests: `mcp-server/test_identity_binding.mjs`, `mcp-server/test_identity_secret_floor.mjs`, `mcp-server/conformance/c6_identity_gates.mjs`
- Docs: GIF-013, GIF-014, `docs/secrets.md`, `docs/runbooks/adopter/first-time-setup.md`
- Verify: `node test_identity_secret_floor.mjs && node test_identity_binding.mjs` (from `mcp-server/`)
- Watch: `identity_token` stays mandatory at `persona_create` (CLAUDE.md non-negotiables)

## Sessions

### Governance sessions
A persona opens a governance session, passes its `gif_session_id` on every governed call, and closes it or lets the TTL expire it.

- Who: any valid persona
- API: tool `session_start` (required `persona_id`, `skipSession`) -> `mcp-server/src/tools/session_start.ts:executeSessionStart`; tool `session_close` (required `persona_id`, `gif_session_id`, `skipSession`) -> `mcp-server/src/tools/session_close.ts:executeSessionClose`
- Services: `mcp-server/src/enforcement.ts` (`_createSession`, `_closeSession`, `_validateSessionHandle`: not found, persona mismatch, closed before expired, DB error fails closed); `mcp-server/src/session.ts` (re-exports); dispatcher gate in `mcp-server/src/index.ts`
- Data: `gif.sessions` (`schema/001_gif_core.sql`, repurposed for v0.2 handles in `schema/013_session_v2_semantics.sql`); audit `event_type` `session_start`, `session_close`, `session_rejected_closed`, `session_expired`
- Settings: `GIF_SESSION_TTL_SECONDS` (default 86400, fail-fast at startup)
- Tests: `mcp-server/test_session_lifecycle.mjs`, `mcp-server/test_session_dispatch.mjs`, `mcp-server/conformance/c1_handle_mint.mjs`, `mcp-server/conformance/c2_dispatch_validation.mjs`, `mcp-server/conformance/c3_closure.mjs`
- Docs: GIF-019, GIF-020, GIF-021, GIF-022 §C1-C3
- Verify: `node test_session_lifecycle.mjs && node test_session_dispatch.mjs` (from `mcp-server/`, stack up)
- Watch: the dispatcher never auto-closes a session (GIF-020)

## Tools

### Governed data access (`db_read`, `db_write`)
The reference adopter tools read from and insert into allowlisted `gif` tables after a scope check, logging violations and audit-class reads.

- Who: `read` for `db_read`; `admin_read` for `db_read` on `personas`; `write` for `db_write`
- API: tool `db_read` (required `persona_id`, `gif_session_id`, `table`; optional `filters`, `limit`) -> `mcp-server/src/tools/db_read.ts:executeDbRead`; tool `db_write` (required `persona_id`, `gif_session_id`, `table`, `record`) -> `mcp-server/src/tools/db_write.ts:executeDbWrite`
- Services: `mcp-server/src/tools/sql-identifier.ts` (`isSafeIdentifier`, `quoteIdentifier`); allowlists `ALLOWED_READ_TABLES`, `ADMIN_READ_TABLES`, `AUDIT_CLASS_TABLES` (`db_read.ts`), `ALLOWED_WRITE_TABLES` = `user_persona_assignments` (`db_write.ts`)
- Data: reads the allowlisted `gif` tables; writes `gif.user_persona_assignments`; `gif.tool_registry` is a readable table (`schema/001_gif_core.sql`, `schema/004_tool_registry_sprint4.sql`)
- Tests: `mcp-server/test_sql_injection.mjs`, `mcp-server/test_mcp.mjs`, `mcp-server/test_read_log.mjs`, `mcp-server/test_audit_trail.mjs`
- Docs: GIF-002, GIF-006
- Verify: `node test_sql_injection.mjs && node test_mcp.mjs` (from `mcp-server/`, stack up)
- Watch: caller-supplied identifiers go through `quoteIdentifier`, values are parameterized (CLAUDE.md "SQL", fixed PR #29)

## Platform

### Schema install and migrations
An installer creates the roles and the `gif` schema, applies each migration in order and records it.

- Who: superuser for bootstrap; `gif_admin` for migrations
- API: `scripts/install.sh` (`GIF_MIGRATIONS`) and `ops/docker/init-db.sh` (`apply_migration` sequence); both must list every migration
- Data: roles and database ownership (`schema/000_bootstrap.sql`); move into the `gif` schema (`schema/005_schema_separation.sql`); removal of `entities` and `relationships` holdover tables (`schema/011_remove_research_pipeline_tables.sql`); `gif.schema_migrations` (`schema/012_schema_migrations.sql`)
- Tests: `mcp-server/test_setup.mjs` (seed personas); CI exercises only `ops/docker/init-db.sh`
- Docs: GIF-016, `docs/runbooks/contributor/schema-migrations.md`, `docs/migrations/`
- Verify: `docker compose up -d` on a fresh volume, then `./scripts/test-local.sh`; check `scripts/install.sh` by hand against a throwaway Postgres
- Watch: the two apply-paths drift silently (CLAUDE.md "SQL", fixed PR #71)

## Background jobs

| Job | Started in | Schedule | Lock | File |
|---|---|---|---|---|
| Audit partition retirement | operator, by hand (`docs/ops-runbook-audit-retention.md`) | none in code | blocked by an active row in `gif.retention_holds` | `ops/retire_audit_partitions.sql`, `schema/009_retention_lifecycle.sql` |

Session expiry is not a job: `_validateSessionHandle` checks the TTL on the next call.

## Public (no login) routes

gif has no login. Identity is the `persona_id` argument on each tool call (a bearer token, CLAUDE.md "Key Architecture Decisions").

| Method | Path | File | Why public |
|---|---|---|---|
| GET | `/health` | `mcp-server/src/index.ts` | Liveness check; returns status only; not Origin-validated |
| any | `/mcp` | `mcp-server/src/index.ts` | MCP endpoint; Origin-validated (403); every `tools/call` then needs a valid `persona_id` |

## Not a feature

| Path | Why |
|---|---|
| `mcp-server/src/db.ts` | Shared pg pool and connection settings |
| `mcp-server/src/enforcement_instance.ts` | Binds `createEnforcement` to gif's own pool |
| `mcp-server/src/persona.ts` | Re-export shim over `enforcement.ts` |
| `mcp-server/src/session.ts` | Re-export shim over `enforcement.ts` |
| `mcp-server/src/tools/types.ts` | Shared `ToolHandler` and `ToolResult` types |
