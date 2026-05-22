# gif — Claude Code Context

## What This Repository Is

gif is the **Governed Intelligence Framework** — AI governance and structural
explainability infrastructure. It enforces authorization before AI tool execution
and records every action in an append-only audit trail that is immutable at the
persistence layer.

gif deploys as a containerized MCP server. The enforcement engine is published
as an importable package (`gif-enforcement`) that adopter tool servers declare
as a versioned git dependency.

---

## Key Architecture Decisions

| Decision | What Is Locked |
|----------|----------------|
| MCP as the sole tool interface | No hardwired tool calls; dispatch is registry-driven |
| Persona scope enforced at MCP layer | Not application layer, not database layer |
| PostgreSQL as sole persistence layer | No other stores |
| Append-only audit trail | INSERT-only at database permission level — structural constraint, not policy |
| Purpose field non-nullable on personas | A persona without declared purpose has no governance value |
| `gif-enforcement` as versioned git dependency | Adopters pin to tags via SSH; no `file:` refs, no floating branches |
| Schema isolation | `gif` schema owns all GIF objects; per-adopter app users carry only required grants |
| Enforcement packaging | Adopters import `createEnforcement` and inject their own pool — no GIF source modification |
| `persona_id` as bearer token | Any process that knows a `persona_id` can call tools under that identity — audit trail + mandatory provisioner identity is the mitigation; structural session binding is a contributor project (GIF-014) |

---

## Non-Negotiable Implementation Constraints

**Audit trail is append-only.** `audit_events` and all audit-related tables use
INSERT-only database permissions. Never suggest UPDATE or DELETE on audit records.

**Persona scope enforced at MCP layer.** Permission checks happen before tool
execution, not in application code. Do not suggest enforcement logic that bypasses
or duplicates the MCP enforcement point.

**Purpose field is non-nullable on personas.** Schema constraint enforced from
Sprint 1. Do not suggest nullable purpose.

**Audit and session logging never throw.** `logAuditEvent()` and
`logScopeViolation()` catch all errors internally. Audit failures must never mask
tool responses or interrupt tool execution.

**gif-enforcement is a versioned git dependency.** Adopter repos declare
`gif-enforcement` via tag-pinned SSH reference:
`git+ssh://git@github.com/notboatanchor/gif.git#v0.1.0`. Version bumps require a
tag in this repo and a dependency update in all adopter repos.

**No secrets in repository.** `.env` is gitignored. Secrets are injected via
environment variables at process startup per GIF-017; the contract and rotation
procedures are in `docs/secrets.md`.

**`identity_token` is mandatory at `persona_create`.** Every persona must have a
verified human identity on record at provisioning time. `identity_token` is
required in both the TypeScript type and `inputSchema.required`. Do not suggest
making it optional.

**`personas` table is gated behind `admin_read`.** `personas` is not in
`ALLOWED_READ_TABLES`. It is in `ADMIN_READ_TABLES` and requires the `admin_read`
action. An AI doing legitimate work has no reason to enumerate other personas.

**`governance_review_status` must be `approved` for dispatch.** `_validatePersona`
blocks any persona with a status other than `approved`. Do not suggest weakening
or bypassing this check.

---

## Compliance Hardening Roadmap

Near-term items before first regulated-industry deployment:
- Cryptographic log signing (hash chains + external timestamping)
- User-to-persona identity binding with verification — provisioner accountability
  is done (mandatory `identity_token` at `persona_create`); runtime session
  binding (structural proof that the AI making calls holds the assigned
  `persona_id`) is deferred to a contributor project per GIF-014

Medium-term:
- Agent-to-agent delegation within sessions
- Dynamic scope adjustment
- Encryption at rest (required before productization)
- Multi-tenant operational hardening

---

## Skills

Project-local skills are in `.claude/skills/` and committed to the repository.
Contributors using Claude Code get them automatically.

| Skill | Purpose |
|-------|---------|
| `gif-eval` | Eval-Driven Development for MCP tools — define pass/fail before implementing |
| `tdd-workflow` | TDD cycle (RED/GREEN/REFACTOR) for MCP tools and service functions |
| `backend-patterns` | Node.js/TypeScript service layer patterns |
| `database-migrations` | Safe migration patterns for gif's schema layer |
| `mcp-server-patterns` | Canonical MCP patterns for gif's tool interface |
| `postgres-patterns` | PostgreSQL patterns for gif's persistence layer |

Build/type/lint/test verification before committing is handled by the global
`verification-loop` skill in Claude Code, which detects gif's stack and runs
the canonical sequence automatically — no project-local copy needed.

---

## Code Style

**SQL**
- Explicit column names — no `SELECT *`
- Comment on every table and every non-obvious column
- Migrations numbered sequentially: `001_gif_core.sql`, `002_gif_core.sql`, etc.
- No table prefixes — the `gif` schema provides the namespace

**TypeScript**
- Strict mode enabled
- `skipLibCheck: true` — required for MCP SDK deep generic chains
- Tool handlers receive `sessionId` as a parameter — never create a session inside a tool handler
- Build: `npm run build` (from `mcp-server/`)

**Commits**
- `feat:` new capability
- `chore:` infrastructure, config, scaffolding
- `fix:` corrections
- `schema:` database schema changes
- `docs:` documentation only

**Documentation**
- Every document should stand alone — a reader should never need to go outside
  it to resolve a question the document itself raises.
- If implementation details are out of scope, say so explicitly and point to
  where they live. Vague references ("register your tools") without a pointer
  are not acceptable.
- When writing docs, ask: does this answer every question it implicitly raises?

---

## Maintaining This File

CLAUDE.md is public contributor context — it ships with the repository and is
read by contributors and Claude Code sessions on any machine.

Keep it lean:
- **Include:** non-negotiables, locked architecture decisions, roadmap items,
  skills inventory, code style rules.
- **Exclude:** current sprint state, migration tables, session logs, internal
  strategic context, anything that describes "where we are right now" rather
  than "how this project works."

Current session state belongs in `project-state.md`, which is gitignored.
