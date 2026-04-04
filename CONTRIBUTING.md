# Contributing to GIF

Thank you for your interest in contributing to the Governed Intelligence Framework.

---

## Maintainer Note

GIF is currently maintained by one person. There is no response SLA on issues or pull requests. PRs will be reviewed when time allows. If you submit something, it may sit for a while — that is not a signal that it is unwanted.

If you are building something on top of GIF and have a specific need, open an issue describing it. Concrete use cases drive prioritization.

---

## Getting Started

The full contributor setup is in [`docs/runbooks/contributor/first-time-setup.md`](docs/runbooks/contributor/first-time-setup.md). It covers cloning, environment setup, Docker stack, and running the test suite.

Before contributing code, read [`docs/gif-101.md`](docs/gif-101.md) — it explains the codebase structure, execution flow, and the constraints that are non-negotiable (append-only audit trail, MCP-layer enforcement, purpose non-nullable on personas).

---

## How to Contribute

**Reporting bugs:** Open a GitHub issue. Include what you were doing, what you expected, and what actually happened. If you have a minimal reproduction, include it.

**Suggesting changes:** Open an issue before writing code. A short description of what you want to change and why avoids the situation where significant work gets submitted that cannot be merged due to architectural conflict.

**Submitting a pull request:**
1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run the full test suite — `npm test` from `mcp-server/` — and confirm all 38 tests pass
4. Follow the commit conventions: `feat:`, `fix:`, `chore:`, `schema:`, `docs:`
5. Open a PR with a description of what changed and why

PRs that touch the enforcement path, audit tables, or persona lifecycle require extra scrutiny. The non-negotiables in [`CLAUDE.md`](CLAUDE.md) define what cannot change without an architecture decision record.

---

## Non-Negotiables

These constraints are structural — they are not up for reconsideration in a PR:

- **Audit trail is append-only.** `audit_events` and related tables are INSERT-only at the database permission level. No PR that adds UPDATE or DELETE to audit tables will be merged.
- **Enforcement at the MCP layer.** Permission checks happen before tool execution. PRs that move or duplicate enforcement logic into application code will not be merged.
- **Purpose field is non-nullable.** Schema constraint, enforced from the start. A Persona without a declared purpose has no governance value.
- **Audit and session logging never throw.** `logAuditEvent()` and `logScopeViolation()` catch all errors internally. Audit failure cannot mask a tool response.

---

## Code Style

**TypeScript:** Strict mode. `skipLibCheck: true` (required for MCP SDK deep generic chains). Tool handlers receive `sessionId` as a parameter — never create a session inside a tool handler.

**SQL:** Explicit column names — no `SELECT *`. Comment on every table and every non-obvious column. Migrations numbered sequentially.

**Tests:** Integration tests, not unit tests. Tests connect to a real database and call the MCP server over HTTP. No mocking the database or the enforcement layer.

---

## Suggested Projects

These are ideas that would add value to the GIF ecosystem. They are not on the core roadmap — they are opportunities for contributors who want to build something meaningful.

**Browser-based admin interface.** A lightweight web UI for Persona management — create, inspect, and revoke Personas; view active sessions; query the audit trail. This would be built entirely on top of GIF's MCP tools and could live as a separate repository. An obvious first project for someone who wants to contribute but prefers frontend work.

**Claude Code / VS Code extension.** A developer tool for managing GIF from within a development environment. Persona creation and audit queries without leaving the editor.

**Semantic audit classification layer.** A post-processing layer that classifies audit records by data type (financial, PII, health data, etc.) based on tool registry metadata. Enables queries like "show all AI access to financial data this week." Built on top of the audit trail, no changes to GIF core required.

**Identity provider integration.** A reference implementation connecting a real identity provider (Auth0, Okta, or similar) to GIF's user-persona assignment model. Would demonstrate the full accountability chain from human SSO identity through Persona to audit record.

**Audit trail export.** A scheduled export of audit records to object storage (S3, GCS) for long-term retention and SIEM integration. Relevant for regulated-industry deployments with multi-year retention requirements.

**Helm chart / Kubernetes deployment.** A production-grade deployment configuration for GIF on Kubernetes, with secret injection patterns, health checks, and resource limits documented.

If you are working on any of these, open an issue to coordinate — it helps avoid duplicate effort.

---

## Architecture Decisions

Significant changes to GIF's architecture require an Architecture Decision Record (ADR). The ADR process is documented in the `decisions/` directory. If your contribution involves a new architectural direction, open an issue first to discuss it before writing code.
