# GIF-022 — v0.2 Conformance Surface

**Status:** Accepted
**Date:** 2026-05-24
**Amended:**

- 2026-05-27 — editorial corrections surfaced while implementing the
  C-series conformance scenarios in `mcp-server/conformance/`. The
  audit-trail read surface is `db_read(table='audit_events')` gated
  by the audit-class read scope (`read` + `audit_events`), not a
  `read_log` tool gated by `admin_read`; and C2.7 audits four (not
  five) rejection cases. No normative MUST changed — only the
  descriptions are corrected to match the reference implementation.
- 2026-05-27 — §C5 scope clarification. Combination-policy MUSTs are
  primitive-level rather than MCP-surface MUSTs. No governed gif MCP
  tool invokes `checkCombinationPolicies` (the primitive is adopter-
  invoked per ADR-022), so C5.1–C5.3 are verified at the primitive
  by `mcp-server/test_combination_policies.mjs` rather than through
  the three MCP surfaces used for C1–C4 and C6. The suite stub at
  `mcp-server/conformance/c5_combination_scoping.mjs` documents this
  and asserts the primitive coverage stays wired into the test
  runner. On extraction to `gif-spec`, C5.x maps to SEP-2484
  documented exclusions (not-protocol-observable). The MUSTs
  themselves are unchanged — only the verification surface is named.

## Decision

The v0.2 conformance surface — the set of behaviors that a
v0.2-conformant GIF implementation MUST exhibit, and the set of
behaviors that remain implementation-defined — is specified below.

The MUST behaviors are not new commitments. They are organization of
commitments already made in GIF-019 (handle mint and propagation),
GIF-020 (closure semantics), GIF-021 (schema), and the long-standing
non-negotiables in CLAUDE.md (append-only audit, audit-never-throws,
persona scope at MCP layer, `personas` admin-read gating,
`identity_token` mandatory at `persona_create`). This ADR consolidates
them into a single conformance contract, draws the required-vs-
implementation-defined line, and stops short of writing the test
fixtures or harness assertions themselves.

This ADR locks **D5** from GIF-018's design space. With D1–D5 now
landed, the v0.2 design pass is complete; v0.2 implementation can
proceed against a stable specification.

## Context

### D5 is shaped differently from D1–D4

D1 (mint point), D2 (propagation channel), D3 (closure semantics), and
D4 (schema impact) were each a choice among mechanisms. D5 is a
**specification of testability**: given the mechanisms chosen, which
behaviors must any conformant implementation expose to an external
test harness, and which behaviors may differ between implementations?

There is one GIF implementation today, and no other implementations
are imminent. D5 is therefore forward-looking. Its value is twofold:

1. **Stabilize the v0.2.0-rc.1 surface** for adopters repinning to
   the RC. Adopters validate their tool handlers and host code
   against a written contract, not against the current
   implementation's behavior.
2. **Constrain implementation drift over time.** Once v0.2 is
   released, future GIF revisions and adopter forks have a written
   contract that distinguishes "behavior change that breaks
   conformance" from "implementation detail that may evolve."

### SEP-2484 alignment

SEP-2484 (conformance suite) is a Final-status gate for MCP Standards
Track work and was the F7 driver behind GIF-018. SEP-2484 has not yet
specified format or structure for conformance test harnesses; this ADR
does not assume one. The MUSTs below are stated as behavioral
requirements observable through the MCP tool surface (`tools/list`
introspection, tool dispatch, response shapes) and the audit-trail
read surface (the `db_read` tool with `table = 'audit_events'`, gated by
the audit-class read scope).
When SEP-2484 evolves to specify harness conventions, those will land
additively in a follow-on ADR; nothing in GIF-022 forecloses them.

### Scope boundary

This ADR specifies what an implementation MUST do at runtime. It does
**not** specify:

- Test fixture format
- Sample harness assertion language
- Conformance levels (e.g., schema-only vs. behavior-complete)
- Wire-level error code names (per GIF-020 §What This ADR Does Not
  Decide, these ship with v0.2.0-rc.1 and may be revised in feedback)

Those belong either to a separate conformance-specification artifact
(out of scope for this repo) or to a follow-on ADR once SEP-2484
clarifies.

## Conformance-Required Behaviors

Each requirement is stated as a single MUST and labeled with its
source ADR or non-negotiable. The source is the authoritative
specification; this ADR consolidates and surfaces them.

### Category 1 — Handle minting

- **C1.1** A conformant implementation MUST expose `session_start`
  as an MCP tool discoverable via `tools/list`. (GIF-019)
- **C1.2** `session_start`'s `inputSchema.required` MUST include
  `persona_id` as a string field. (GIF-019)
- **C1.3** `session_start` MUST validate `persona_id` against the
  existing persona record (governance review status `approved`,
  active, non-revoked) before minting. The validation MUST use the
  same path that governed-tool dispatch uses. (GIF-019, CLAUDE.md
  `governance_review_status` non-negotiable)
- **C1.4** On successful mint, `session_start` MUST return a
  `gif_session_id` field of type string in its response. The string
  MUST be unique across the implementation's session history; it
  MUST identify exactly one session row. (GIF-019)
- **C1.5** A successful `session_start` MUST result in exactly one
  audit-event row of type `session_start` linked to the new
  `session_id`. (GIF-019)
- **C1.6** A failing `session_start` (persona invalid, persona not
  approved, persona revoked) MUST emit the rejection through the
  documented `PersonaInvalidReason` surface and MUST NOT result in
  a `session_start` audit event being emitted. (GIF-019)

### Category 2 — Governed-tool dispatch validation

- **C2.1** Every governed tool (every tool whose handler receives a
  non-empty `sessionId` parameter via dispatch — operationally,
  every tool not flagged `skipSession=true`) MUST include
  `gif_session_id` as a required string field in its
  `inputSchema.required`. (GIF-019)
- **C2.2** A governed call with `gif_session_id` missing from
  `args` MUST be rejected before the tool handler executes.
  (GIF-019, M4)
- **C2.3** A governed call with `gif_session_id` referring to no
  existing session row MUST be rejected before the tool handler
  executes. (GIF-019)
- **C2.4** A governed call with `gif_session_id` whose owning
  `persona_id` does not match the asserted caller `persona_id`
  MUST be rejected before the tool handler executes. (GIF-019,
  F2 bearer-token model)
- **C2.5** A governed call with `gif_session_id` for a session
  whose `sessions.ended_at IS NOT NULL` MUST be rejected with the
  closed-session error condition. The closed condition MUST take
  precedence over the expired condition (closure precedence:
  closed > expired). (GIF-020)
- **C2.6** A governed call with `gif_session_id` for a session
  satisfying `now() > sessions.started_at +
  GIF_SESSION_TTL_SECONDS` MUST be rejected with the expired-
  session error condition. (GIF-020)
- **C2.7** All four session-handle rejection cases above (unknown
  handle, persona mismatch, closed, expired) MUST emit an audit
  event recording the rejection. (The missing-`gif_session_id`
  case is rejected at the protocol layer with an `InvalidParams`
  error before handle validation runs and emits no audit event —
  a malformed request is not a governance rejection.) The audit
  emission is best-effort per the audit-never-throws
  non-negotiable; a failed emission does not change the rejection
  response. (CLAUDE.md audit-never-throws, GIF-020 §C6)

### Category 3 — Closure

- **C3.1** A conformant implementation MUST expose `session_close`
  as an MCP tool discoverable via `tools/list`. (GIF-020)
- **C3.2** `session_close`'s `inputSchema.required` MUST include
  both `persona_id` and `gif_session_id`. (GIF-020)
- **C3.3** `session_close` MUST validate persona ownership (same
  check as C2.4) before performing any state change. (GIF-020)
- **C3.4** On successful close, `session_close` MUST set
  `sessions.ended_at = now()` AND emit a `session_close` audit
  event linked to the `session_id`. Both writes are part of the
  successful-close commitment; an implementation that emits the
  audit event without setting `ended_at`, or sets `ended_at`
  without emitting the audit event, is non-conformant. (GIF-020)
- **C3.5** `session_close` against an already-closed session MUST
  reject (rejection MUST NOT be a silent no-op). The rejection
  itself MUST emit an audit event recording the attempt.
  (GIF-020)
- **C3.6** TTL expiry MUST be enforced lazily on the next governed
  call. A conformant implementation MUST NOT require a background
  sweeper process to enforce TTL. An implementation that emits
  `session_expired` events from a background sweeper in addition
  to lazy enforcement is conformant; an implementation that emits
  them *only* from a sweeper and not lazily on the next governed
  call is not. (GIF-020, F5 stateless-dispatch)
- **C3.7** TTL value MUST be read at process startup from the
  `GIF_SESSION_TTL_SECONDS` environment variable; the documented
  default (86400 seconds) MUST apply when the variable is unset.
  (GIF-020)

### Category 4 — Audit event emission

- **C4.1** All audit-event tables (`audit_events` and any audit-
  related tables introduced by future migrations) MUST be INSERT-
  only at the database permission level. No UPDATE or DELETE
  permission for the application user role. (CLAUDE.md append-
  only non-negotiable, GIF-003)
- **C4.2** The v0.2 session lifecycle MUST be representable
  through the following four audit event types: `session_start`,
  `session_close`, `session_expired`, `session_rejected_closed`.
  A conformant implementation MUST emit these types in the
  conditions specified above (C1.5, C3.4, C3.6, C2.5
  respectively). Additional implementation-specific event types
  are permitted; the four listed are the minimum surface.
  (GIF-019, GIF-020)
- **C4.3** Every lifecycle audit event MUST link to a
  `session_id` — the newly-minted one for `session_start`, or the
  existing one for `session_close`, `session_expired`, and the
  closed-handle case of `session_rejected_closed`. The one
  exception is the unknown-handle dispatch rejection (C2.3), which
  emits a `session_rejected_closed` event with `session_id = NULL`
  because no session exists to reference. (GIF-019, GIF-020)
- **C4.4** Audit event emission MUST NOT throw into the tool
  response path. A failed audit INSERT MUST be logged
  out-of-band and MUST NOT change the response the caller
  receives. (CLAUDE.md audit-never-throws non-negotiable)
- **C4.5** The audit trail MUST be readable via the `db_read` MCP
  tool with `table = 'audit_events'`, gated by the audit-class
  read scope (the `read` action plus `audit_events` in the
  persona's `permitted_sources`). A conformance harness reads
  audit events through this tool, not through direct database
  access. (CLAUDE.md append-only audit trail; audit-table read
  access is scope-gated and distinct from the `personas`
  `admin_read` gate of C6.2.)

### Category 5 — Combination policy scoping

*Verification surface — primitive-level.* The Category 5 MUSTs apply
to the `checkCombinationPolicies` enforcement primitive exported
from `gif-enforcement`. The primitive is adopter-invoked per
ADR-022; no governed MCP tool in the reference implementation calls
it, so C5.1–C5.3 are not observable through the three MCP surfaces
named in §What a Conformance Harness Needs to Introspect. They are
verified at the primitive level by
`mcp-server/test_combination_policies.mjs` (case 5 in particular
witnesses the accumulation behavior asserted by C5.1 and C5.2), and
pointed at from the suite stub
`mcp-server/conformance/c5_combination_scoping.mjs`. C5.3 is
satisfied transitively by C2.2–C2.6 — invalid-handle calls are
rejected before reaching the combination-policy evaluation point.
On extraction to `gif-spec`, C5.x entries map to SEP-2484 documented
exclusions (not-protocol-observable flavor).

- **C5.1** Combination policy accumulation MUST scope to a single
  `gif_session_id`. The accumulation query reads `audit_events`
  filtered by `session_id`. (GIF-011, GIF-019)
- **C5.2** Combination policy accumulation MUST NOT bleed across
  distinct `gif_session_id` values. A call carrying handle A
  cannot accumulate sources from a call carrying handle B, even
  when both belong to the same persona. (GIF-019 §Consequences)
- **C5.3** Combination policy accumulation MUST NOT occur for
  calls that lack a valid `gif_session_id`, because such calls
  are rejected at C2.2/C2.3/C2.4/C2.5/C2.6 before reaching the
  combination-policy evaluation point. (GIF-020 §M4 no-silent-
  fallback)

### Category 6 — Identity and provisioning gates

- **C6.1** `persona_create` MUST require `identity_token` in its
  `inputSchema.required`. An implementation accepting a persona
  creation without `identity_token` is non-conformant. (CLAUDE.md
  `identity_token` mandatory non-negotiable, GIF-014)
- **C6.2** The `personas` table MUST be reachable from MCP only
  through the `admin_read` action, never through the generic
  `read` action on `db_read`. An implementation that includes
  `personas` in the application-user readable-table allowlist is
  non-conformant. (CLAUDE.md admin-read gating non-negotiable)
- **C6.3** Dispatch MUST reject any persona with
  `governance_review_status != 'approved'`. An implementation
  that weakens or skips this check is non-conformant. (CLAUDE.md
  governance-review non-negotiable)

## Implementation-Defined Behaviors

The following are explicitly **not** conformance-required. A
conformant implementation may differ from GIF's reference behavior
on any of these:

- **I1 — Internal index strategies** on `gif.sessions` and any
  audit tables. The dispatcher's hot-path query patterns are
  load-bearing (C2.x); the indexes that support them are not.
- **I2 — Wire-level error code names.** GIF's
  `SESSION_EXPIRED`/`SESSION_CLOSED`/etc. wire codes ship with
  v0.2.0-rc.1 and may be revised in RC feedback (GIF-020). The
  *audit event types* (C4.2) are conformance-required; the
  caller-facing wire codes are not.
- **I3 — `gif_session_id` format beyond "string".** The reference
  implementation uses Postgres `gen_random_uuid()`. Conformance
  requires the value be a string and uniquely identify a session;
  it does not require UUID format.
- **I4 — `invocation_context` query semantics.** The reference
  implementation treats this JSONB column as opaque adopter-
  supplied metadata. A future implementation that queries it for
  routing or policy is conformant as long as the field is
  preserved verbatim per GIF-021.
- **I5 — Additive schema columns.** Implementations may add
  columns to `gif.sessions` or other tables for forward-
  compatibility with future SEPs (e.g., transport-session
  correlation per F9, trace context per SEP-414). Additive
  columns are conformant; column removals or column-meaning
  changes are not.
- **I6 — TTL configuration mechanism.** Conformance requires the
  effective TTL be honored (C2.6, C3.7) and read from a runtime-
  configurable source. Whether that source is an environment
  variable, config file, deployment secret manager, or
  orchestration-injected value is implementation-defined.
- **I7 — Persistence substrate.** The reference implementation
  uses PostgreSQL per the CLAUDE.md non-negotiable for *this*
  implementation. Conformance is defined behaviorally
  (`tools/list`, dispatch responses, audit-event content);
  another implementation built on a different substrate would be
  conformant if its observable behavior matched the MUSTs.
- **I8 — Performance characteristics.** Latency, throughput,
  partitioning strategy, connection-pool configuration, and
  caching policies are all implementation-defined.
- **I9 — Source-file vs. live-catalog comment text.** Live-
  database `COMMENT ON` content is canonical per GIF-021; source-
  file inline comments may drift. Conformance does not assert on
  comment text either way.
- **I10 — Internal noexcept-handling code paths.** Conformance
  requires the audit-never-throws behavior (C4.4); the specific
  try/catch shape, logging destination, or fallback queue is
  implementation-defined.

## What a Conformance Harness Needs to Introspect

For a conformance harness to assert the MUSTs above against a
running implementation, the implementation MUST expose:

- **`tools/list`** returning the complete tool registry, including
  `session_start`, `session_close`, every governed tool with its
  `inputSchema.required` array. (Used to assert C1.1, C1.2, C2.1,
  C3.1, C3.2, C6.1.)
- **Tool dispatch** with caller-supplied `persona_id` and
  `gif_session_id` arguments and observable response shapes for
  both success and rejection. (Used to assert C2.2–C2.7, C3.3–C3.5,
  C6.3.)
- **Audit-trail read access via `db_read` (`table =
  'audit_events'`)** gated by the audit-class read scope (`read`
  action + `audit_events` in `permitted_sources`), returning audit
  events filterable by `session_id` and `event_type`. (Used to
  assert C1.5, C1.6, C3.4, C3.5, C4.1–C4.5. C5.x is verified at the
  enforcement primitive — see §Category 5.)

These three surfaces are sufficient. A conformance harness does
not require direct database access, does not require
implementation-internal logging, and does not require timing
guarantees beyond what is observable through tool responses.

## Migration Path

Per M1, M2, and M3 (GIF-018), the v0.1 → v0.2 migration runbook
gains the following entry in `docs/migrations/v0.1-to-v0.2.md`:

1. **Conformance contract:** Adopters and downstream
   implementations validate v0.2 behavior against the MUSTs in
   GIF-022 §Conformance-Required Behaviors. The implementation-
   defined items in §Implementation-Defined Behaviors are
   explicitly *not* part of the v0.2 contract — adopters relying
   on those behaviors are relying on implementation detail and
   may break across versions or implementations.

No schema or code change is introduced by this ADR. The MUSTs
specify behavior already required by GIF-019/020/021 and the
existing non-negotiables; this ADR consolidates them into a
single referenceable specification.

## What This ADR Does Not Decide

- **Test fixture format and harness assertion language.** Belongs
  either to a separate conformance-specification artifact or to a
  follow-on ADR once SEP-2484 clarifies.
- **Conformance levels** (e.g., schema-only conformance vs.
  full-behavior conformance). SEP-2484 may define a level
  taxonomy; this ADR specifies a flat surface (all listed MUSTs
  are required for v0.2 conformance).
- **Wire-level error code names.** Per GIF-020, these ship with
  v0.2.0-rc.1 and may be revised. The audit-event types are
  locked; the caller-facing wire codes are RC-period detail.
- **Conformance test access controls.** Whether a conformance
  harness uses a dedicated admin persona, a separate test-only
  scope, or any other access pattern is implementation-defined.
  The reference implementation expects the harness to use a
  persona with the audit-class read scope (`read` + `audit_events`)
  for audit-trail reads and an `admin_read`-capable persona for the
  `personas` table; other patterns are conformant if they meet the
  C4.5 and C6.2 read-access requirements.
- **Backward-conformance with v0.1.** v0.1 had no equivalent
  surface; v0.2 conformance is a clean break per M4 (no silent
  fallback).
- **SEP-2484 alignment specifics.** When SEP-2484 leaves Draft and
  publishes harness conventions, a follow-on ADR aligns this
  surface with those conventions if they require changes. None of
  the MUSTs above are expected to soften under that alignment;
  they may be reorganized or relabeled.

## Non-Negotiables Touched

- **Append-only audit trail (GIF-003, CLAUDE.md):** consolidated as
  C4.1; conformance requires INSERT-only DB permissions on audit
  tables.
- **Audit-never-throws (CLAUDE.md):** consolidated as C4.4 and
  C2.7; conformance requires audit emission be noexcept.
- **`identity_token` mandatory at `persona_create` (CLAUDE.md):**
  consolidated as C6.1.
- **`personas` table admin-read gating (CLAUDE.md):** consolidated
  as C6.2.
- **`governance_review_status` gate (CLAUDE.md):** consolidated as
  C6.3.
- **`persona_id` bearer-token model (GIF-013, GIF-014):**
  preserved by C2.4, C3.3 ownership checks. The bearer-token
  posture is unchanged by v0.2's addition of a second token
  (`gif_session_id`); both tokens are validated on every governed
  call.
- **Persona scope enforced at MCP layer:** preserved; conformance
  requires the dispatcher's pre-handler checks (C2.x), which is
  the MCP-layer enforcement point.

## Cross-references

- GIF-003 — Append-only audit trail
- GIF-011 — Combination policies (the v0.1 mechanism C5.x
  preserves)
- GIF-013 — Runtime identity accountability
- GIF-014 — `persona_id` bearer-token model
- GIF-018 — Stateless MCP session handles (scoping ADR; this ADR
  closes D5 / OQ-D5)
- GIF-019 — Session handle: mint point and propagation (source
  for C1.x, C2.1)
- GIF-020 — Session closure semantics (source for C2.5, C2.6,
  C3.x, C4.2)
- GIF-021 — Session schema repurpose (source for I4, I5, I9)
- SEP-2484 — Conformance suite (Final-status gate; future
  alignment ADR will land additively here)
- SEP-2575, SEP-2567 — Stateless protocol core
- Issue #8 — Tracking issue for the full v0.2 effort
- `docs/migrations/v0.1-to-v0.2.md` — Migration narrative
