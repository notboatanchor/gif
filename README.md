# Governed Intelligence Framework (GIF)

AI governance and structural explainability infrastructure. GIF sits between an AI model and the tools it can invoke — enforcing authorization before execution and recording every action in an append-only audit trail that is immutable at the persistence layer.

---

## What It Does

When an AI agent invokes a tool, GIF:

1. **Checks the Persona** — is this governance identity active, within its validity window, and permitted to call this tool?
2. **Enforces scope** — calls outside the Persona's declared scope are rejected and logged as first-class governance events, not errors
3. **Records everything** — every permitted call, every rejection, every session; INSERT-only at the database permission level

The result: when a regulator asks why your AI accessed a record, the answer is a complete chain — Persona, declared purpose, delegation authority, tool name, parameters, timestamp. Immutable and queryable.

---

## Key Concepts

**Persona** — a governance identity for an AI agent. Carries a declared purpose (required, non-nullable), an explicit tool scope, temporal validity bounds, and a delegation chain. Created by human administrators before any AI action occurs.

**Scope** — an enumerated list of what a Persona may do. Not implied, not inferred. If a tool isn't in scope, the AI cannot call it.

**Scope Violation** — a first-class governance record, not an error log entry. Evidence that the boundary worked.

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

The enforcement engine ships as an importable package (`gif-enforcement`). Adopters import it as a versioned git dependency and register their own domain tools against it — no GIF source modification required.

See [`docs/gif-101.md`](docs/gif-101.md) for a technical walkthrough of the codebase and execution flow.

---

## Quick Start

**Prerequisites:** Docker Engine 24+, Docker Compose v2, Git.

```bash
git clone --branch v0.1.0 git@github.com:scottrhodes/gif.git
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
| [`docs/runbooks/contributor/`](docs/runbooks/contributor/) | Contributors | First-time setup, schema migrations |
| [`docs/runbooks/adopter/`](docs/runbooks/adopter/) | Adopters | First-time setup, upgrade path |

---

## Current State

GIF is at v0.1.0. Core enforcement is complete and validated end-to-end:

- Persona lifecycle (create, activate, expire, revoke)
- MCP enforcement layer with Streamable HTTP transport
- Append-only audit trail (INSERT-only at database level)
- Scope violation detection as first-class governance events
- Delegation chain enforcement (scope subset rules, depth limits)
- Session management as discrete governance events
- Tool registry and registry-driven dispatch
- Enforcement packaging as an importable module

The compliance hardening roadmap (cryptographic log signing, user-to-persona identity binding, encryption at rest) is documented in [`docs/gif-product-overview.md`](docs/gif-product-overview.md).

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## License

Apache License, Version 2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

Copyright 2026 Notboatanchor Labs LLC.
