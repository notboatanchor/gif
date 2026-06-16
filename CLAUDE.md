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

**`governance_review_status` gates dispatch via an `auto_approved`/`approved`
allowlist.** Per ADR-017 the governance review is a structural stub that
auto-approves until a future gif-side governance layer is installed.
`_validatePersona` passes only `auto_approved` (the schema default) and
`approved`, and rejects everything else — `pending` (review withheld) and any
unrecognized state (closed by default). Do not narrow the pass set to `approved`
alone — that rejects the default state no shipped path produces (the f344442
regression, reconciled in GIF-022 §C6.3). Do not rewrite it as `!= 'pending'`
either — keep the explicit allowlist so the gate stays closed if the governance
ENUM grows. When the real governance layer lands, tighten deliberately via an
ADR, not silently.

**`gif_session_id` is required on every governed tool's `inputSchema`.** Type
must be `string` with `uuid` format; the dispatcher pre-validates the handle
via `validateSessionHandle` before tool execution. Tool handlers never
re-implement session validation — they receive the validated `sessionId` as a
parameter and trust it. See GIF-019, GIF-022 §C2.

**Dispatcher does not auto-close sessions.** Session closure is caller-driven
(`session_close` tool) or TTL-driven (`GIF_SESSION_TTL_SECONDS`, default
86400). Do not add a `finally`-block close on the dispatch path — v0.1's
per-call auto-close is the behavior v0.2 removes. See GIF-020.

**`validateSessionHandle` is the exported adopter-contract primitive.**
Adopters import it from `gif-enforcement` and call it as the single source of
truth for session-handle validity. Adopters must not re-implement closure
precedence (closed > expired) or TTL handling. `GIF_SESSION_TTL_SECONDS` is
parsed once at process startup with fail-fast on misconfig (non-finite or
non-positive). See GIF-020, GIF-022 §C2.

**Enforcement, audit, and schema changes require review before merge.** Any
change touching `schema/`, `mcp-server/src/tools/`, `mcp-server/src/enforcement.ts`,
or the audit trail must pass a code + security review and a clean-install
(`npm ci`) test run before merge. These layers carry the framework's security
and tamper-evidence guarantees; the review gate is mandatory for them, not
optional. Do not merge enforcement/audit/schema work on an in-session "green"
alone — verify on a clean install.

**Audit canonical form is byte-identical across all three implementations.** The
PG trigger (`schema/0NN_audit_canonical_json*.sql`), the `verify_audit_chain.ts`
verifier (`buildBody*`), and the `.mjs` test-harness replicas must produce
byte-identical canonical preimages — the hash chain's tamper-evidence is only as
trustworthy as `emit ≡ verify`. Any change to canonicalization updates all three
sites together and reproduces the sealed KAT before merge (the same silent-drift
hazard as the migration apply-paths rule below). Never backfill or rewrite
`canon_version` on existing rows — historical rows verify under the version they
were stamped with.

**Structural claims about the code cite their source.** Any assertion that the
code drifts, mismatches, is broken, or that a test vector equals a given digest
— recorded in an ADR, a code comment, a doc, an issue, a commit message, or
project state — must carry an inline source citation (commit SHA + `file:line`,
or the external preimage) in the same edit that records it. An uncited
structural claim is marked unverified, not stated as fact. The review-before-merge
gate above catches unverified *code*; it does not catch a claim entered as
prose. A misread "`GovernanceReviewStatus` enum drift" claim, recorded without
checking the type definition, rode ~15 sessions into a public conformance
comment before it was caught (retracted PR #32, 2026-06-12).

---

## Compliance Hardening Roadmap

Near-term items before first regulated-industry deployment:
- Cryptographic log signing — chain verifier CLI (hash chain trigger landed
  in migration 006; verifier walks partitions, recomputes SHA-256, reports
  mismatches and chain breaks)
- External timestamping anchors for the audit hash chain
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
- A new migration must be wired into **both** apply-paths — `scripts/install.sh`
  (`GIF_MIGRATIONS`) and `ops/docker/init-db.sh` (`apply_migration` sequence).
  These are parallel and drift silently when only one is updated.
- Caller-supplied SQL identifiers (table / column names) route through
  `mcp-server/src/tools/sql-identifier.ts` (`quoteIdentifier` = validate +
  escape); values are always parameterized (`$1, $2, …`). Never interpolate
  caller input as a bare `"${x}"` — it is an injection vector (fixed PR #29).

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
