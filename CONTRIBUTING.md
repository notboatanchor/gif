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
3. Run the full test suite — `npm test` from `mcp-server/` — and confirm all 48 tests pass
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

**Runtime session binding (structural AI-to-persona authorization).** Today, `persona_id` is a bearer token — any process that knows it can call tools under that identity. GIF-014 documents why this is acceptable for general deployments and what mitigates the risk. For adopters with high-assurance runtime authorization requirements — regulated industries, multi-tenant deployments, or environments where cryptographic proof of authorization is required — a session binding mechanism would close this gap. The design: at MCP session initialization, the AI presents its `assignment_id` (the persistent credential returned by `persona_create`). GIF validates the assignment, records the MCP session → persona binding, and rejects tool calls where the claimed `persona_id` does not match the binding. Extension points are already in place: the `transports` map in `index.ts` (keyed by MCP session ID), `user_persona_assignments.assignment_id`, and a new `session_bindings` table for the audit record. This would live in GIF core as an opt-in enforcement mode, not a breaking change to the default behavior.

**Agent identity bridge.** GIF guarantees that every persona has a provisioning human on record, but runtime operator accountability — which human account an AI is running as, and which service account intermediates that — is an adopter obligation (GIF-013). Today, adopters fulfill this by passing free-form JSON into `invocation_context`. An agent identity bridge would make this structured and reusable: integrate with a real IdP (GitHub OAuth is a concrete starting point), manage the assignment lifecycle via API rather than CLI, track runtime sessions (agent + service account + authorizing human), and produce the structured `invocation_context` payload GIF expects. The `scripts/issue_identity_token.mjs` CLI in this repo is the seed of this component. The bridge would live as a separate repository — it is adopter infrastructure, not GIF core (GIF-012).

**Audit trail export.** A scheduled export of audit records to object storage (S3, GCS) for long-term retention and SIEM integration. Relevant for regulated-industry deployments with multi-year retention requirements.

**Helm chart / Kubernetes deployment.** A production-grade deployment configuration for GIF on Kubernetes, with secret injection patterns, health checks, and resource limits documented.

If you are working on any of these, open an issue to coordinate — it helps avoid duplicate effort.

---

## Architecture Decisions

Significant changes to GIF's architecture require an Architecture Decision Record (ADR). The ADR process is documented in the `decisions/` directory. If your contribution involves a new architectural direction, open an issue first to discuss it before writing code.
