# Governed Intelligence Framework (GIF)

Every access control system ever built was designed for humans — one person, one query, one purpose at human speed. AI agents broke that assumption.

A single agent can issue thousands of queries across unrelated data sources in seconds. Each query individually permissible. Each individually logged. The inference from the aggregate — a privacy violation, a regulatory exposure, a competitive intelligence breach — that no existing framework catches, because HIPAA, GDPR, and every other governance standard was built to evaluate records, not trajectories.

GIF is a governance runtime for AI tool invocation. It enforces persona scope at the MCP layer before any tool executes, and provides the primitive that lets adopter tool servers reject the call that would complete a restricted *combination* of data accesses — not just the individual call.

---

## What It Does

When an AI agent invokes a tool, GIF:

1. **Checks the Persona** — is this governance identity active, within its validity window, and permitted to call this tool?
2. **Enforces scope** — calls outside the Persona's declared scope are rejected and logged as first-class governance events, not errors.
3. **Evaluates combination policies** — adopter tool handlers invoke a GIF-provided evaluator before execution; if the combination of data sources accessed in the current session crosses a declared sensitivity threshold, the call that would complete the restricted combination is blocked. Financial records alone may be permissible; HR records alone may be permissible; communications metadata alone may be permissible. The join of all three — across separate calls in seconds — may not be.
4. **Records everything** — every permitted call, every rejection, every session; INSERT-only at the database permission level.

The result: when a regulator asks why your AI accessed a record, the answer is a complete chain — Persona, declared purpose, delegation authority, tool name, parameters, timestamp. Immutable and queryable.

---

## What Makes This Different

- Most governance tools are audit layers — they log what happened, after it happened. GIF enforces before execution.
- Most governance tools evaluate individual actions. GIF's combination-policy primitive evaluates trajectories — the accumulated set of data sources an agent has touched across a session.
- The audit trail in GIF is a byproduct of enforcement, not the product. The enforcement is the product.
- The Persona model is not a service account. It carries a declared purpose (non-nullable, schema constraint), explicit scope, temporal bounds, and a delegation chain. An AI agent without a declared purpose cannot act.

---

## Key Concepts

**Persona** — a governance identity for an AI agent. Carries a declared purpose (required, non-nullable), an explicit tool scope, temporal validity bounds, and a delegation chain. Created by human administrators before any AI action occurs.

**Scope** — an enumerated list of what a Persona may do. Not implied, not inferred. If a tool isn't in scope, the AI cannot call it.

**Scope Violation** — a first-class governance record, not an error log entry. Evidence that the boundary worked.

**Combination Policy** — a declared rule that a specific set of data sources, accessed together within a session, constitutes a governance boundary regardless of whether each individual access is in scope. GIF provides the schema, the active-policy evaluator, and fail-closed semantics (GIF-011). Adopter tool servers invoke the evaluator at their own dispatch points (GIF-012 framework boundary). The v0.1 evaluator uses first-match policy resolution; exhaustive evaluation is a v0.2 trajectory item.

**Audit Trail** — INSERT-only at the database permission level. The application role cannot UPDATE or DELETE audit records. This is a structural constraint, not a policy.

**Delegation Chain** — child Personas hold strict subsets of parent scope. Multi-agent systems stay governed: every sub-agent's actions trace back through the chain to the root administrative authority.

See [`docs/gif-plain-language-guide.md`](docs/gif-plain-language-guide.md) for a full plain-language explanation, or [`docs/gif-product-overview.md`](docs/gif-product-overview.md) for the complete technical overview.

---

## Architecture

Two Docker containers: a PostgreSQL 16 database and a Node.js MCP server.

```
Client (AI model)
    ↓  HTTP POST to :3100/mcp
MCP Server — validates Persona, enforces scope, dispatches tool
    ↓
PostgreSQL — personas, sessions, audit_events, scope_violations
```

The enforcement layer evaluates persona scope at the MCP boundary for every dispatched tool call. The combination-policy evaluator is exposed as a primitive (`checkCombinationPolicies`) that adopter tool servers invoke at their own dispatch points (GIF-012 framework boundary; GIF-011 combination policies). The combination of these two enforcement layers is what makes GIF a governance runtime rather than a governance log.

The enforcement engine ships as an importable package (`gif-enforcement`). Adopters import it as a versioned git dependency and register their own domain tools against it — no GIF source modification required.

See [`docs/gif-101.md`](docs/gif-101.md) for a technical walkthrough of the codebase and execution flow.

---

## Quick Start

**Prerequisites:** Docker Engine 24+, Docker Compose v2, Git.

```bash
# HTTPS (no SSH key required):
git clone --branch v0.2.0-rc.4 https://github.com/notboatanchor/gif.git
# Or SSH:
# git clone --branch v0.2.0-rc.4 git@github.com:notboatanchor/gif.git

cd gif
cp .env.example .env   # fill in passwords and secrets
docker compose up -d --build
```

On first start, the database initializes itself — roles, schema, and all migrations apply automatically. No manual SQL required.

Verify:
```bash
curl -s http://localhost:3100/health
# → {"status":"ok","service":"gif-mcp-server"}
```

See [`docs/runbooks/contributor/first-time-setup.md`](docs/runbooks/contributor/first-time-setup.md) for the full contributor setup, or [`docs/runbooks/adopter/first-time-setup.md`](docs/runbooks/adopter/first-time-setup.md) for integrating GIF into your own application.

---

## Documentation

| Document | Audience | What It Covers |
|----------|----------|----------------|
| [`docs/gif-plain-language-guide.md`](docs/gif-plain-language-guide.md) | Technical decision-makers | What GIF is, how it works, key concepts |
| [`docs/gif-product-overview.md`](docs/gif-product-overview.md) | Architects, evaluators | Full technical overview, regulatory alignment, roadmap |
| [`docs/gif-101.md`](docs/gif-101.md) | Contributors, integrators | Codebase walkthrough, execution flow, schema |
| [`docs/architecture-diagrams.md`](docs/architecture-diagrams.md) | All technical | Request flow, schema ER, persona lifecycle, delegation |
| [`docs/secrets.md`](docs/secrets.md) | Operators, adopters | Env-var contract, vault reference patterns, rotation procedures |
| [`docs/runbooks/contributor/`](docs/runbooks/contributor/) | Contributors | First-time setup, schema migrations |
| [`docs/runbooks/adopter/`](docs/runbooks/adopter/) | Adopters | First-time setup, upgrade path |

---

## Current State

`v0.2.0-rc.4` is the recommended pin. It runs on the MCP SDK 2.0 substrate (`@modelcontextprotocol/server` + `/node` at `2.0.0-beta.1`, ESM-only) and carries the v0.2 governance-session semantics: explicit `gif_session_id` handles minted by `session_start` (the MCP 2026-07-28 spec's server-minted session-handle model, SEP-2567), caller-driven close, and wall-clock TTL. Core enforcement is complete and validated end-to-end against a real PostgreSQL 16 instance — no functional mocks. The integration suite (persona lifecycle, MCP enforcement, audit trail, hash chain, identity binding, delegation, retention, combination policies, SQL-identifier safety) plus the six GIF-022 conformance scenarios run on every commit via CI. TypeScript strict mode throughout.

The RC line tracks MCP SDK 2.0 prereleases through the spec RC window; the pin moves to `^2.0.0` at `v0.2.0` final. The server currently negotiates the `2025-11-25` protocol revision on the wire — serving the `2026-07-28` revision (`server/discover`, cache envelopes) requires the SDK's `createMcpHandler` hosting layer and is queued for `v0.2.0` final.

**Legacy (`v0.1.0`).** `v0.1.0` is the pre-session-handle release on the retired MCP SDK v1 substrate. It is no longer recommended: it predates the SQL-identifier hardening on the v0.2 line (PR #29 — caller-supplied filter and column names reached `db_read`/`db_write` queries unescaped) and receives no backports. Existing v0.1.x adopters should upgrade via [`docs/migrations/v0.1-to-v0.2.md`](docs/migrations/v0.1-to-v0.2.md).

Shipped capabilities:

- Persona lifecycle (create, activate, expire, revoke)
- MCP enforcement layer with Streamable HTTP transport
- Append-only audit trail (INSERT-only at database level)
- Scope violation detection as first-class governance events
- Delegation chain enforcement (scope subset rules, depth limits)
- Session management as discrete governance events
- Tool registry and registry-driven dispatch
- Enforcement packaging as an importable module
- Combination policy primitive (schema, active-policy evaluator, fail-closed semantics; adopter-invoked)
- Provisioner identity binding (HMAC identity token issued by CLI; verified at persona_create; human_actor_id on every audit event)

The compliance hardening roadmap (chain verifier CLI for the existing hash-chained audit trail, encryption at rest, multi-tenant operational hardening) is documented in [`docs/gif-product-overview.md`](docs/gif-product-overview.md).

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## License

Apache License, Version 2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

Copyright 2026 Notboatanchor Labs LLC.
