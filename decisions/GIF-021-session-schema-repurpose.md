# GIF-021 — Session Schema: Repurpose Sessions Table in Place

**Status:** Accepted
**Date:** 2026-05-24
**Amended:**

- 2026-06-15 — SEP-1299 status corrected in "What This ADR Does Not
  Decide." SEP-1299 is not a Draft SEP that may advance; it is GitHub
  issue #1299 (pre-SEP-1850 numbering), now `closed`, and did not land
  in the 2026-07-28 RC. The deferred transport-session correlation
  column is re-gated on an equivalent client-to-session binding
  mechanism being standardized, not on "SEP-1299 leaving Draft." No
  decision in this ADR changed. Source: `gh issue view 1299 --repo
  modelcontextprotocol/modelcontextprotocol` (2026-06-15) — state
  CLOSED, closed 2025-09-02.

## Decision

The v0.2 governance session schema reuses the existing `gif.sessions`
table. No DDL changes, no row purge, no FK migration. The numbered
migration that lands with v0.2 (`013_session_v2_semantics.sql`) is
**comment-only**: it updates the table comment and column comments to
reflect v0.2 semantics (per GIF-019 and GIF-020) and drops obsolete
domain-specific framing for `invocation_context` left over from a
pre-split codebase.

The table keeps its name, its primary key (`session_id`), its persona
foreign key, its timestamp columns (`started_at`, `ended_at`), and its
free-form `invocation_context` JSONB. Every existing FK reference to
`sessions(session_id)` — from `audit_events`, `scope_violations`,
`audit_read_log`, and the Sprint-3 partitioned `audit_events` recreated
in migration 002 — is preserved unchanged.

This ADR locks D4 from GIF-018's design space. D5 (conformance-surface
specifics) remains open.

## Context

GIF-018 surfaced D4 as a binary question: repurpose `sessions` in place,
or introduce a new `session_handles` table. GIF-019 minted the v0.2
handle through `session_start`, and GIF-020 specified closure semantics
(caller-close + hard wall-clock TTL, lazy expiry). Both ADRs deliberately
deferred the broader schema-impact decision; both reused the existing
table in their adopter-contract specifications. This ADR closes that
deferral.

### What the existing schema already provides

From `schema/001_gif_core.sql`:

```sql
CREATE TABLE sessions (
    session_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    persona_id          UUID NOT NULL REFERENCES personas(persona_id),
    started_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    ended_at            TIMESTAMP WITH TIME ZONE,
    invocation_context  JSONB
);

CREATE INDEX idx_sessions_persona_id ON sessions(persona_id);
CREATE INDEX idx_sessions_started_at ON sessions(started_at);
```

Every column v0.2 needs is already present:

- `session_id` is the v0.2 governance handle (`gif_session_id` at the
  wire layer per GIF-019).
- `persona_id` carries the bearer-token ownership check that
  `session_close` (GIF-020) and the dispatcher's per-call validation
  verify.
- `started_at` is the TTL basis (`now() > started_at +
  GIF_SESSION_TTL_SECONDS` per GIF-020).
- `ended_at` carries the caller-close denormalization (GIF-020 path 1)
  and remains NULL for paths 2 and 3.
- `invocation_context` is adopter-supplied free-form session metadata
  per GIF-019's `session_start` contract — generalizing the
  domain-specific shape (fixed `pipeline_phase` / `topic` /
  `configuration_id` / `triggered_by` fields) that ships in the
  column's current comment.

The dispatcher's per-call hot path is a single `SELECT` by primary key
on this table. The existing PK index handles it. No new index is
introduced.

### Why repurpose-in-place

The other two options from GIF-018 D4 (introduce a new table; rename
`sessions` to `session_handles`) carry costs that this option avoids:

- **Introduce a new table.** Heavy migration: new table DDL, four FK
  changes on dependent tables, and a decision about historical
  per-call rows (orphan, archive, dual-table, or drop). Without
  adopters in production, the migration cost is theoretical — but the
  resulting *runtime* topology is still two session-shaped tables
  for the same conceptual entity. Future readers of `audit_events`
  would need to know which table the FK now references and why the
  old one still exists.
- **Rename `sessions` → `session_handles`.** ALTER TABLE RENAME
  auto-updates FK metadata, so the migration itself is light. But the
  rename creates a naming asymmetry: the column on `audit_events` is
  `session_id`, not `session_handle_id`. Restoring symmetry would
  require renaming `audit_events.session_id` everywhere it's
  referenced — a much heavier code-and-test migration touching every
  query against `audit_events`. The marginal naming clarity does not
  pay for that.

The v0.1 ephemeral rows fit v0.2 semantics without translation. Under
v0.1 dispatch, every `sessions` row was created and closed inside the
same handler, so every existing row already has `ended_at != NULL`.
Under v0.2's `ended_at IS NULL = active` predicate (GIF-020), v0.1
rows read as old closed sessions — which is what they are. There is
no double-meaning at query time and no cleanup-pass required for
correctness.

### Why no row purge

A natural temptation, given no adopters in production, is to TRUNCATE
v0.1 rows during the v0.2 cutover for cleanliness. This is **not** the
right move for two reasons:

1. **Audit-trail non-negotiable.** Every existing `sessions` row is
   FK-referenced by one or more `audit_events` rows. TRUNCATE CASCADE
   would cascade-delete those audit rows, violating the append-only
   audit-trail non-negotiable (CLAUDE.md, GIF-003). DELETE without
   CASCADE fails on the FK RESTRICT default. The schema is built so
   that historical session rows cannot be erased without erasing the
   corresponding audit history.

2. **Historical rows are correct under v0.2 semantics.** They
   represent real session events that happened, were logged, and ended.
   The audit narrative they support is unchanged by v0.2. There is
   nothing to "clean up."

The migration therefore introduces no DELETE, no TRUNCATE, and no FK
modification.

## Forces Satisfied

The forces F1–F9 are stated across GIF-018 and GIF-019. This ADR
addresses each:

- **F1 (combination policy preserved):** Combination accumulation
  continues to query `audit_events` by `session_id`. The session row
  the predicate references is the same row across v0.1 and v0.2.
- **F2 (bearer-token model not weakened):** `persona_id` FK is
  unchanged. Ownership verification at `session_close` and at every
  governed call uses the existing column.
- **F3 (append-only audit trail):** No DELETE, no TRUNCATE, no FK
  modification that could cascade-delete `audit_events`. The
  comment-only migration touches Postgres system-catalog metadata
  exclusively.
- **F4 (breaking adopter contract, written explicitly):** No schema
  delta for adopters to migrate around. The migration is recorded
  in `docs/migrations/v0.1-to-v0.2.md` for completeness.
- **F5 (stateless dispatch on GIF side):** Dispatcher reads the
  session row by PK; no caching, no background sweep. Unchanged.
- **F6 (honest-caller seam unchanged):** Schema does not touch the
  `incomingSourceRefs` surface.
- **F7 (conformance load-bearing):** Conformance harnesses query
  `sessions` by `session_id`; the table name and column names are
  stable across v0.1 and v0.2.
- **F8 (opportunistic interoperability):** SEP-414 `traceparent`
  capture, if it lands in v0.2, can use the existing
  `invocation_context` JSONB column without schema change. Same for
  any SEP-1299 transport-session correlation field (F9
  forward-compat).
- **F9 (forward-compatibility with SEP-1299):** Any future column to
  carry a transport-layer client correlation (e.g., a public-key
  thumbprint per RFC 9421) lands as an additive `ALTER TABLE ADD
  COLUMN` against the existing table. No structural change required.

## Migration 013 — Comment-Only

```sql
-- Migration 013: repurpose sessions for v0.2 governance handles
-- No DDL, no row changes, no FK changes.
-- Updates Postgres system-catalog comments to reflect v0.2 semantics
-- per GIF-019 (mint and propagation) and GIF-020 (closure semantics).

BEGIN;

COMMENT ON TABLE gif.sessions IS
    'Governance session rows minted by the session_start MCP tool '
    '(GIF-019). One row represents one logical work session whose '
    'combination-policy source accumulation is scoped to a single '
    'gif_session_id. Lifecycle is caller-close (session_close tool) '
    'or hard wall-clock TTL via GIF_SESSION_TTL_SECONDS (GIF-020).';

COMMENT ON COLUMN gif.sessions.started_at IS
    'Session mint timestamp. Basis for TTL expiry under GIF-020 '
    '(now() > started_at + GIF_SESSION_TTL_SECONDS rejects with '
    'SESSION_EXPIRED on the next governed call).';

COMMENT ON COLUMN gif.sessions.ended_at IS
    'Null while the session is active OR after TTL-driven dormancy '
    'with no subsequent governed call (GIF-020 path 3). Set to now() '
    'only by the session_close tool handler. Note: ended_at IS NULL '
    'does not imply "active" — combine with started_at + TTL to '
    'determine effective state.';

COMMENT ON COLUMN gif.sessions.invocation_context IS
    'Adopter-supplied free-form session metadata, captured at '
    'session_start and immutable thereafter. Snapshot semantics — '
    'supports point-in-time reconstruction of caller-declared '
    'session intent independent of subsequent state changes.';

COMMIT;
```

The migration is idempotent (`COMMENT ON` overwrites prior comments)
and reversible (re-run an older migration with the prior comment
text). It runs as part of init-db.sh's standard apply-once flow per
migration 012's tracking table.

### What this migration does NOT touch

- `sessions` table DDL (no ALTER, no DROP, no CREATE)
- Indexes (`idx_sessions_persona_id`, `idx_sessions_started_at`
  remain)
- FK constraints on dependent tables
- Row contents
- Source files of prior migrations (001 is not edited; migrations are
  append-only documentation of schema evolution)

## Consequences

### C1 — Source-file documentation drift

The `CREATE TABLE sessions` block in `schema/001_gif_core.sql`
contains an inline SQL comment block (lines 153-157) describing the
v0.1 prescribed shape of `invocation_context` (pipeline_phase,
topic, configuration_id, triggered_by). That inline comment is
**not** stored in Postgres system catalogs — it is source-file
documentation only. Migration 013 cannot update it without rewriting
a prior migration file, which would violate the migrations-are-
append-only convention. The source-file comment in 001 is therefore
stale post-013; readers of the source file must know that comment
content in the live database reflects the most recent migration's
`COMMENT ON` statements, not the inline source comments of the
original `CREATE TABLE`.

This is a deliberate tradeoff: source-file comments are historical
artifacts of the migration in which they shipped. The migration
history is the canonical record of schema evolution.

### C2 — Historical row interpretation

`sessions` rows minted before migration 013 follow v0.1 dispatch
semantics: each row's `started_at` is the timestamp of a single tool
call, and `ended_at` is set milliseconds later when the same handler
closed the row. Under v0.2 read predicates, these rows are
indistinguishable from "very brief logical sessions." The audit
trail's `audit_events` rows scoped to those `session_id` values are
historically correct (the tool calls happened); the v0.2 reader
should not assume those sessions represent extended workflows.

Operators or auditors wanting to filter to v0.2-style sessions can
filter on `ended_at IS NULL OR (ended_at - started_at) > interval
'1 second'` — heuristic but reliable, given v0.1's per-call lifetime
was sub-second.

### C3 — Forward-compatibility surface remains open

Future SEPs or GIF roadmap items (transport-session correlation for
F9; W3C Trace Context capture for SEP-414; parent-session linkage
for agent-to-agent delegation; per-persona TTL overrides per
GIF-020 §C5) can all land as additive `ALTER TABLE ADD COLUMN`
migrations against the existing table. The repurpose-in-place
decision does not foreclose any of them.

### C4 — Index sufficiency

The dispatcher's hot path (per-call SELECT by `session_id`) uses the
PK index. The `session_close` validation path uses the PK index.
`session_start` is an INSERT. The maintenance-shaped query "active
sessions for persona X" (e.g., during persona revocation cascades or
operator forensics) uses the existing `idx_sessions_persona_id`.
None of v0.2's documented access patterns require a new index in
this migration. A partial index on `(persona_id) WHERE ended_at IS
NULL` could be added in a future additive migration if maintenance
query performance becomes observably load-bearing.

## Migration Path

Per M1, M2, and M3 (GIF-018), the v0.1 → v0.2 migration runbook
gains the following entries in `docs/migrations/v0.1-to-v0.2.md`:

1. **Schema:** Apply migration `013_session_v2_semantics.sql`.
   Idempotent and comment-only. No table rewrite, no row migration,
   no downtime.
2. **No adopter code change required by this migration.** The
   adopter-facing v0.2 contract changes specified by GIF-019 (the
   `session_start` tool and `gif_session_id` arg) and GIF-020
   (`session_close` tool, `GIF_SESSION_TTL_SECONDS` env var, new
   error codes) cover the application surface. Schema is internal.
3. **Historical rows interpretation:** Operators upgrading from v0.1
   to v0.2 are advised that pre-013 rows are v0.1 per-call ephemera
   and that the heuristic in §C2 distinguishes them from v0.2-style
   logical sessions if needed for analytics or audit reconstruction.

## What This ADR Does Not Decide

- **Per-persona TTL.** Deferred per GIF-020 §C5. Would land as an
  additive column (`personas.session_ttl_seconds` or a similar
  override) in a future ADR.
- **Transport-session correlation column.** Deferred. SEP-1299 (the
  client-session-binding proposal, GitHub issue #1299) is closed and
  did not land in the RC; this column would land additively if an
  equivalent client-to-session binding mechanism is standardized.
- **SEP-414 W3C Trace Context capture column.** Deferred. Could use
  `invocation_context` JSONB or land as a dedicated column; choice
  depends on whether trace correlation becomes a queryable predicate
  or stays as opaque metadata.
- **Parent-session linkage for agent-to-agent delegation.**
  Deferred. Roadmap item; schema impact (e.g., a
  `parent_session_id` self-FK) is downstream of the delegation
  design.
- **Source-file comment refresh in 001_gif_core.sql.** Deliberately
  not done. Migration files are append-only documentation; source
  drift is accepted as the cost of that convention. The live
  database's system-catalog comments are the canonical reflection of
  current schema intent.
- **Conformance-surface specifics (D5).** Separate deliverable.
- **Cleanup of the active_sessions_terminated semantics under v0.2
  TTL.** The `persona_revocations.active_sessions_terminated` column
  (schema/001) currently records sessions closed by revocation. Under
  v0.2 with TTL, revocation should still cascade-close active
  sessions for the revoked persona; the counter's semantics carry
  over without schema change. Behavioral specification belongs in a
  future ADR or in the conformance-surface deliverable, not in D4.

## Non-Negotiables Touched

- **Append-only audit trail (GIF-003):** preserved; no DELETE, no
  TRUNCATE, no FK modification that could cascade-delete
  `audit_events`. Migration touches only Postgres system-catalog
  metadata.
- **Persona scope enforced at MCP layer:** unchanged; schema is
  internal infrastructure, not policy.
- **`persona_id` bearer-token model (GIF-013, GIF-014):** preserved;
  the `personas` FK on `sessions` is unchanged and still load-bearing
  for the ownership check on `session_close` and per-call dispatch.
- **Framework boundary (GIF-012):** preserved; no operational
  surface introduced.

## Cross-references

- GIF-003 — Append-only audit trail (the non-negotiable that forecloses
  TRUNCATE of historical sessions)
- GIF-011 — Combination policies (the v0.1 mechanism this schema
  continues to underwrite)
- GIF-013 — Runtime identity accountability
- GIF-014 — `persona_id` bearer-token model
- GIF-018 — Stateless MCP session handles (scoping ADR; this ADR
  closes D4 / OQ-D4)
- GIF-019 — Session handle: mint point and propagation (the v0.2
  surface this schema supports)
- GIF-020 — Session closure semantics (the lifecycle this schema
  records)
- Migration 013 — `schema/013_session_v2_semantics.sql`
- Issue #8 — Tracking issue for the full v0.2 effort
- `docs/migrations/v0.1-to-v0.2.md` — Migration narrative
