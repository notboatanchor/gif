# GIF-019 — Session Handle: Mint Point and Propagation Channel

**Status:** Accepted
**Date:** 2026-05-23

## Decision

The v0.2 governance session handle (`gif_session_id`) is:

1. **Minted by a new MCP tool, `session_start`.** The caller dispatches
   `session_start` with a validated `persona_id`; GIF mints a handle,
   inserts a row in `gif.sessions`, emits a `session_start` audit event,
   and returns the handle in the tool response.

2. **Propagated as an explicit, required argument named `gif_session_id`**
   on every governed tool's `inputSchema`. Tools that do not require a
   governance session (`persona_validate`, `session_start`) are exempted
   via the existing `skipSession` flag.

The handle is **not** carried in `_meta`, **not** carried in headers, and
**not** derived from any MCP transport-level identifier. It is application
data, visible at the tool schema layer, asserted by conformance harnesses
via `tools/list` introspection.

This ADR locks D1(b) and D2(a) from the design space scoped in GIF-018.
Closure semantics (D3), schema impact (D4), conformance surface specifics
(D5), and `_meta.traceparent` co-shipping (D6) are explicitly **not**
decided here; they are deferred to follow-on ADRs in the v0.2 design pass.

## Context

GIF-018 scoped the design problem. The MCP 2026-07-28 Specification
Release Candidate removes the `initialize` handshake and `Mcp-Session-Id`
header from the protocol core (SEP-2575, SEP-2567); protocol-version,
client info, and client capabilities travel in `_meta` on every request,
and the protocol no longer maintains session identity at the transport
layer. The RC announcement post recommends an explicit-handle pattern for
any application-level state that spans calls.

GIF v0.1's combination-policy mechanism (GIF-011) accumulates sources
across calls sharing a `sessions.session_id`. In current dispatch
(`mcp-server/src/index.ts:118-157`), each call mints a fresh per-call
session and closes it inside the same handler, so the cross-call
accumulation query at `mcp-server/src/enforcement.ts:611-621` returns
the empty set in production today. The v0.1 design assumed the caller
would thread a stable session across calls implicitly via the MCP
transport session; that assumption never held in code, and the RC
removes the protocol-level structure it was supposed to ride on.

v0.2 therefore must mint a governance session and require the caller
to thread it explicitly. This ADR fixes how and where.

## Forces Satisfied

The forces F1–F8 are stated in GIF-018. The choices below address each:

- **F1 (combination policy preserved):** `_checkCombinationPolicies`
  continues to query `audit_events` by `session_id`; the handle now has
  a meaningful, cross-call scope.
- **F2 (bearer-token model not weakened):** `session_start` validates
  `persona_id` before minting, identical to v0.1's per-call validation
  posture. The handle adds a second bearer token, but its issuance is
  gated by the existing identity check and recorded in the audit trail.
- **F3 (append-only audit trail):** Lifecycle events
  (`session_start`, future `session_close` / `session_expire`) are
  INSERT-only rows in `audit_events`. `gif.sessions` row mutation is
  deferred to D3/D4; no decision here introduces an UPDATE that the
  audit trail relies on for correctness.
- **F4 (breaking adopter contract, written explicitly):** Every
  governed tool's `inputSchema` gains a required field; adopters repin
  to the v0.2 tag and update call sites. The contract delta is
  documented in `docs/migrations/v0.1-to-v0.2.md`.
- **F5 (stateless dispatch on GIF side):** The enforcement engine
  still reads session sources from `audit_events` on each call. No
  in-memory session state is introduced.
- **F6 (honest-caller seam unchanged):** The handle changes the
  *which session am I in* seam. `incomingSourceRefs` remains the
  honest-caller seam for *which sources this call touches*. This ADR
  does not market the handle as closing that gap.
- **F7 (conformance load-bearing):** Both decisions optimize for
  external observability. A conformance harness can call `tools/list`
  to assert `gif_session_id` is a required field on governed tools,
  call `session_start` and assert the response shape, exercise tools
  with the returned handle, and assert combination-policy accumulation
  across calls sharing a handle.
- **F8 (opportunistic interoperability):** `_meta` is left available
  for `traceparent` propagation (SEP-414) without contention. The
  decision to co-ship SEP-414 with v0.2 is deferred (D6).

## F9 — Forward-Compatibility with SEP-1299

This ADR introduces a ninth force, recorded explicitly because it
shaped the choice of D2(a) over D2(b).

**F9 — Forward-compatibility with SEP-1299.** SEP-1299
("Server-Side Authorization Management with Client Session Binding")
is a Draft-status proposal that, if adopted, would introduce a
cryptographic proof-of-possession between an MCP client instance and
an MCP server via HTTP Message Signatures (RFC 9421). Its session
concept is *transport-layer client continuity* — "the same client is
making this subsequent call" — and lives in request headers.

GIF v0.2's `gif_session_id` is *application-layer governance scoping*
— "this set of calls is one logical unit of work whose combination of
touched sources is jointly evaluated against policy." It lives in
tool input.

The two are orthogonal: SEP-1299 proves *who*; GIF v0.2 scopes *what
work*. Keeping `gif_session_id` in tool arguments — not in `_meta`,
not in headers — preserves a clean composition surface. If SEP-1299
or a successor lands, the structural runtime-binding extension point
GIF-014 documents ("MCP session → `assignment_id` verification,
contributor project") can be implemented as a binding between
`user_persona_assignments.assignment_id` and the SEP-1299 client
public key, without contention with the governance handle.

SEP-1299 itself is **not a dependency.** It is Draft, not yet PR'd,
and may never land. This force is about not foreclosing it, not
about waiting for it.

## Adopter Contract

### New MCP tool: `session_start`

```
Input:
  persona_id        string   required
  invocation_context object  optional   // free-form, e.g., {"workflow": "intake"}

Output:
  gif_session_id    string   // UUID

Behavior:
  - Validates persona via existing _validatePersona path
    (returns the documented PersonaInvalidReason on failure).
  - INSERTs a row into gif.sessions with persona_id and invocation_context.
  - INSERTs a session_start audit event linked to the new session_id.
  - Returns the session_id.

Marked skipSession=true.
```

Lifecycle (closure, timeout, TTL) is **not specified by this ADR.** The
follow-on ADR addressing D3/OQ3 will define when and how a session
ends. Until that ADR lands, sessions remain open after `session_start`;
adopters should treat the v0.2.0-rc.1 surface as not-yet-final on
closure semantics.

### Tool schema delta for every governed tool

Every governed tool (i.e., every tool whose handler today receives a
non-empty `sessionId` parameter via the dispatch path in
`mcp-server/src/index.ts:118-131`) gains:

```
inputSchema:
  type: object
  properties:
    gif_session_id:
      type: string
      description: Governance session handle from session_start.
    ...existing fields...
  required:
    - gif_session_id
    - ...existing required fields...
```

Tools currently flagged `skipSession=true` (e.g., `persona_validate`,
and the new `session_start`) are exempted.

### Dispatch flow

For every governed call:

1. Validate persona (`_validatePersona`, unchanged).
2. Look up `gif_session_id` from `args`.
3. Verify the session exists in `gif.sessions`, belongs to the
   asserted `persona_id`, and has not been closed or expired (closure
   semantics deferred to D3 — until that ADR lands, only the
   exists-and-persona-matches check is enforced).
4. Execute the tool handler with the validated `sessionId`.
5. Log the audit event linked to that `sessionId`.
6. **Do not close the session.** Per M4, the v0.2 dispatcher does not
   mint or close a session implicitly; session lifecycle is caller-
   driven.

A call that omits `gif_session_id`, presents an unknown handle, or
presents a handle bound to a different `persona_id` is rejected with
a documented error code. The error code surface is enumerated in the
v0.1 → v0.2 migration runbook; the specific code list lands as part
of the v0.2.0-rc.1 surface and may be revised in RC feedback.

### What does NOT change

- The `persona_id` bearer-token model (GIF-013, GIF-014). The handle
  does not replace, weaken, or wrap `persona_id`.
- The honest-caller seam on `incomingSourceRefs` (GIF-011 §6.5.5).
- The framework boundary (GIF-012). `session_start` is a governance
  dispatch point, not an operational hook.
- Adopter tool handler bodies, beyond receiving an additional
  argument and threading it through `_logAuditEvent` /
  `_checkCombinationPolicies` (which already accept `sessionId`).

## Consequences

**For adopters consuming `gif-enforcement` as a versioned git
dependency (GIF-007):** the v0.2 tag carries a breaking interface
change. Repin, update tool handler call sites to read and forward
`gif_session_id`, add `session_start` calls at session boundaries in
host code. Per F4 and M4, there is no silent v0.1 fallback.

**For conformance:** the contract is externally observable. A
conformance harness can introspect `tools/list`, exercise
`session_start`, exercise governed tools with the returned handle,
and assert that:

- A valid handle is accepted; a missing, unknown, or persona-
  mismatched handle is rejected.
- Combination policies accumulate across calls sharing a handle and
  do not accumulate across calls with distinct handles or with no
  handle.
- A `session_start` audit event appears in the expected position
  before the first governed tool call.

The exact assertion specification — required vs. implementation-
defined behaviors — is the conformance-surface deliverable (D5).

**For the audit trail:** new event type `session_start` is introduced.
The shape of the row uses existing `audit_events` columns; no schema
change is required for this ADR alone. The audit-event-type registry
(if/when one exists as a separate document) gains an entry.

**For schema:** `gif.sessions` semantics shift from one-row-per-call
to one-row-per-logical-session. The repurpose-vs-new-table decision
(D4) is deferred. Until D4 lands, the existing table is reused
in-place; the `ended_at` column is left NULL until a future
closure-semantics ADR specifies when and by what mechanism it is
set.

**For SDK packaging:** the v0.2 work targets the MCP 2026-07-28
Specification Release Candidate. The reference TypeScript SDK has
published prerelease alphas under a new package layout
(`@modelcontextprotocol/server`, `/node`, `/hono` at `2.0.0-alpha.N`);
GIF's `1.x`-series imports change during the v0.2 implementation.
The package-import migration is a v0.2.0 runbook entry distinct from
the session-handle migration this ADR specifies.

## Migration Path

Per M1, M2, and M3, the v0.1 → v0.2 migration gains the following
entries in `docs/migrations/v0.1-to-v0.2.md` as the session-handle
change is the largest single migration item:

1. **Schema:** None required by this ADR. The D4 follow-on ADR may
   introduce a numbered migration.
2. **Dependency repin:** Adopters update `gif-enforcement` git
   dependency to the v0.2.0 tag.
3. **Host code:** Adopters add a `session_start` call at the
   beginning of each logical work session and thread the returned
   `gif_session_id` through every subsequent governed tool call.
4. **Tool handler call sites:** Adopter tool handlers that today
   receive `sessionId` from the dispatcher continue to do so; the
   change is upstream of the handler, at the dispatcher's argument-
   validation layer.
5. **Error handling:** Adopters handle the new error codes for
   missing / unknown / persona-mismatched handles.
6. **Smoke-test expectations:** Adopter smoke tests must call
   `session_start` before exercising governed tools; tests that
   relied on v0.1's silent per-call session minting will not run on
   v0.2 deployments (M4 — no silent fallback).

## What This ADR Does Not Decide

- **Closure semantics (D3 / OQ3).** Caller-close, inactivity timeout,
  hard TTL, or a combination. Until D3 lands, sessions remain open
  after `session_start`.
- **Schema impact (D4).** Whether to repurpose `gif.sessions` or
  introduce a new table. This ADR uses the existing table in place
  without committing to either path.
- **Conformance-surface specification (D5).** Which behaviors a
  conformance harness must assert vs. which are implementation-
  defined. This ADR creates the surface; the specification is a
  separate deliverable.
- **`_meta.traceparent` propagation (D6 / OQ6).** Whether SEP-414
  ships in v0.2.0 or later.
- **MCP Apps coverage (OQ7).** How sandboxed UI iframes (SEP-1865)
  carry or share a governance handle.
- **Error code surface.** The exact list of error codes returned on
  missing / unknown / persona-mismatched handle ships with the
  v0.2.0-rc.1 implementation and may be revised in RC feedback.

These deferrals are intentional. This ADR is the smallest
self-contained step that unblocks implementation: with mint point
and propagation channel locked, the schema, closure, and conformance
work can proceed against a stable interface contract.

## Non-Negotiables Touched

- **Combination policy enforcement (GIF-011):** preserved by F1;
  cross-call accumulation now has a session container that the caller
  threads explicitly.
- **`persona_id` bearer-token model (GIF-013, GIF-014):** preserved
  by F2; the handle is governance-scoped, not identity-scoped, and
  does not weaken the existing posture.
- **Append-only audit trail (GIF-003):** preserved by F3;
  `session_start` is an INSERT into `audit_events`. No UPDATE is
  introduced by this ADR.
- **Framework boundary (GIF-012):** preserved by F5; no in-memory
  session state; `session_start` is a dispatched governance event,
  not an operational concern.
- **Honest-caller seam (GIF-011 §6.5.5):** preserved by F6; the
  handle changes the session-identity seam, not the source-
  declaration seam.

## Cross-references

- GIF-003 — Append-only audit trail
- GIF-007 — Versioned git dependency (adopter repin contract)
- GIF-011 — Combination policies (the v0.1 mechanism this ADR
  preserves and finally makes load-bearing in code)
- GIF-012 — Framework boundary
- GIF-013 — Runtime identity accountability
- GIF-014 — `persona_id` bearer-token model (extension point F9
  references)
- GIF-018 — Stateless MCP session handles (scoping ADR this ADR lands
  specifics for; D1(b) and D2(a) from its design space)
- SEP-2575, SEP-2567 — Stateless protocol core in the MCP
  2026-07-28 Specification Release Candidate
- SEP-414 — W3C Trace Context (opportunistic interop hook; D6 / OQ6)
- SEP-1865 — MCP Apps (audit/consent coverage; OQ7)
- SEP-2484 — Conformance suite (Final-status gate driving F7)
- SEP-1299 — Server-Side Authorization Management with Client
  Session Binding (Draft, orthogonal to v0.2; force F9 is about
  forward-compatibility, not dependency)
- Issue #8 — Tracking issue for the full v0.2 effort
- `docs/migrations/v0.1-to-v0.2.md` — Migration narrative
