# GIF-018 — Stateless MCP Session Handles

**Status:** Proposed (scoping)
**Date:** 2026-05-23

## Purpose of This ADR

This is a **scoping ADR**. It records the problem GIF v0.2 must solve, the
forces that constrain the solution, the design space, and the migration
constraints that bound any specific choice. It does not select a specific
mechanism. A follow-on ADR (or amendment to this one, advancing it to
Accepted) will land the specifics during the v0.2 design pass.

Issue: notboatanchor/gif#8.

## Context

### The MCP RC removes the protocol-level session

The MCP 2026-07-28 Specification Release Candidate (locked 2026-05-21,
introduced via SEP-2575 and SEP-2567) removes the `initialize` handshake
and the `Mcp-Session-Id` transport header from the protocol core. After
the RC ships in Final form, an MCP request is a standalone JSON-RPC call;
the protocol no longer maintains a session identity across calls at the
transport layer.

This is a deliberate move toward stateless serverless deployments and
horizontal scalability. It is not a bug to work around. Any state that
spans multiple tool calls now belongs to the application, not the
transport.

### What GIF v0.1 currently uses the MCP session for

Two distinct uses, currently entangled in code:

1. **Transport routing.** `mcp-server/src/index.ts` keys a `transports`
   map by `mcp-session-id` so subsequent requests over Streamable HTTP
   reach the established transport instance. This use is purely
   protocol-mechanical — GIF doesn't read the header for governance.

2. **Per-call session row in `sessions`.** Every governed tool call
   creates a row in `gif.sessions` via `createSession()` at
   `enforcement.ts:319` and closes it after the audit event is logged
   (`closeSession()` at `enforcement.ts:333`). The returned
   `sessions.session_id` is stamped onto the corresponding row in
   `audit_events` and onto the `_checkCombinationPolicies` candidate-set
   query (`enforcement.ts:612`).

The combination-policy mechanism (GIF-011) computes
`{sources already touched this session} ∪ {sources this call will touch}`
by querying `audit_events` for rows sharing the current call's
`session_id`. In v0.1's current dispatch, that lookup returns the empty
set, because `session_id` is freshly minted per call. The intended
cross-call accumulation works only when *the caller* threads a stable
`session_id` across multiple invocations — implicitly, today, by sharing
an MCP transport session whose lifetime exceeds a single call.

### Why this matters for v0.2

When MCP no longer provides a transport-level session, GIF's combination
policy machinery loses its implicit container. The session that gives
"sources already touched this session" a meaning has to come from
somewhere — and the only place left is for GIF to mint it and the caller
to thread it explicitly.

This ADR scopes the design problem of doing that minting and threading
in a way that:
- Preserves combination policy enforcement as documented in GIF-011.
- Does not weaken the bearer-token model documented in GIF-013 and
  GIF-014.
- Does not blur the framework boundary established in GIF-012.
- Gives v0.1 adopters a migration path with a written contract.

The redesign itself is not in question: GIF v0.2 must adapt to the
MCP RC, full stop. This ADR scopes the *design* problem.

## Forces

The following forces shape any acceptable solution. They are not ranked;
all must be respected by the eventual specific design.

### F1 — Combination policy must still accumulate across calls

GIF-011 is the highest-value v0.1 enforcement primitive. Its
cross-call-accumulation property — that a policy can fire when the
*combination* of sources crosses a threshold even if no single call
crosses it — is what distinguishes GIF from per-call scope enforcement.
The v0.2 design must not regress this property.

### F2 — The bearer-token model must remain at least as strong

GIF-013 and GIF-014 establish that `persona_id` is accepted as a bearer
token at v0.1, with the audit trail, provisioner accountability, and
admin-read gating as the documented mitigations. The new session handle
adds a second governance bearer token to every call. Any minting and
acceptance mechanism must not give an AI new ways to enumerate, forge,
or escalate sessions beyond what the existing mitigations cover. A
minting mechanism that hands out session handles before the calling
identity is at least partially established is weaker than v0.1, not
stronger.

### F3 — Append-only audit trail must absorb the new lifecycle

GIF-003 makes `audit_events` and related tables INSERT-only at the
database permission level. Whatever events represent the session
handle's lifecycle (mint, in-use, close, expire, revoke) must fit the
INSERT-only contract. No UPDATE of a session row to "active=false" that
the audit trail relies on for correctness.

### F4 — Adopter contract is a breaking change either way

Every governed tool call in v0.2 will carry an additional argument
(the session handle) or will read it from an `_meta` field on the
request. Adopters cannot opt out — combination policies don't work
without it. The migration cost is unavoidable; the design choice is
about minimizing it and writing a clear contract, not eliminating it.
This is what the `v0.2.0-rc` milestone signals: adopters get an RC
period to repin and re-test against the new contract before final.

### F5 — Stateless dispatch on the GIF side

GIF-011 specifically rejected in-memory session state on the
enforcement side: the engine reads session sources from `audit_events`
on every call, not from a process-local cache. This is what makes the
enforcement engine horizontally scalable. Any v0.2 design that
reintroduces in-memory session state on the GIF process is a
regression against GIF-011's stated rationale.

### F6 — Honest-caller seam must remain honest about itself

GIF-011 establishes that `incomingSourceRefs` is supplied by the
caller — combination policy enforcement assumes an honest caller for
*which sources this call touches*. The v0.2 handle does not change
that honest-caller seam; it changes only the *which session am I in*
seam. Neither this ADR nor the v0.2 documentation should let the
handle be marketed as closing the honest-caller gap, because it does
not.

### F7 — Conformance is now load-bearing

SEP-2484 makes a conformance test suite a Final-status gate for MCP
Standards Track work. Whatever v0.2 ships must be testable by an
external conformance harness — not just by GIF's own integration
tests. This constrains the design toward observable, contract-level
behavior (handle in, handle out, audit events emitted) rather than
internal-state behavior that's hard to assert from outside.

### F8 — Opportunistic interoperability

Two adjacent SEPs offer opportunistic alignment without forcing a
design choice:
- **SEP-414 (W3C Trace Context):** `_meta.traceparent` correlation
  between GIF audit events and adopter OpenTelemetry spans. The session
  handle's plumbing through `_meta` makes this easy if we land it.
- **SEP-1865 (MCP Apps):** sandboxed UI iframes route through the same
  audit/consent path as tool calls. The v0.2 handle must govern both
  surfaces uniformly, or the audit trail develops a hole.

These do not force a specific design; they suggest the design should
not foreclose them.

## Design Space

The choices below are surfaced for scoping. **None is selected in this
ADR.** The eventual specific design will pick a point in each axis and
record the rationale in the follow-on ADR.

### D1 — Where is the session handle minted?

- **(a) At `persona_create`.** Minting the handle when the persona is
  provisioned ties the handle's lifetime to the persona's. Simple to
  implement and removes the need for a separate session-start dispatch.
  Tension: if a persona is reused across many logical sessions, those
  sessions share one handle — which either widens the combination-policy
  accumulation window or requires re-mint semantics that effectively
  reintroduce a separate session lifecycle. The follow-on ADR must
  resolve this tension or rule the option out.
- **(b) At a new `session_start` MCP tool.** A dedicated dispatch point
  where the caller asks GIF to mint a session. Clean separation of
  concerns; matches the explicit-handle pattern recommended in the MCP
  RC announcement post. Costs an extra round-trip at the start of each
  logical session.
- **(c) Implicit on first governed call.** First call mints; subsequent
  calls reuse via the handle returned in the response. Removes the
  round-trip but blurs lifecycle (no clean "start" event in the audit
  trail).
- **(d) Adopter-supplied, GIF-validated.** Adopter generates the
  handle, GIF accepts and binds. Maximally flexible; weakest by default
  unless GIF enforces a structural format and provenance check.

### D2 — How is the handle propagated on each call?

- **(a) Explicit tool argument** (e.g., `gif_session_id`) on every
  governed tool's `inputSchema`. Visible at the schema layer;
  conformance-testable; one more field on every tool input.
- **(b) `_meta` field on the request.** Per MCP convention for
  protocol-adjacent metadata. Less visible at the tool schema layer;
  aligns with SEP-414 (`_meta.traceparent`) plumbing.
- **(c) Hybrid: `_meta` primary, argument fallback.** Compatibility
  hedge for adopters whose MCP clients can't yet set `_meta`. More
  surface area to test.

### D3 — Lifetime and closure semantics

- **(a) Caller-closed.** Adopter explicitly calls `session_close`. Clear
  audit event; trusts the caller to close.
- **(b) Inactivity timeout.** GIF expires sessions that have not seen a
  call in N minutes. Robust against silent caller failure; requires a
  background sweeper or lazy-expiry check that complicates the
  stateless-dispatch property (F5).
- **(c) Hard wall-clock TTL.** Sessions live for at most N minutes from
  mint. Bounds blast radius of a leaked handle; may surprise long-running
  workflows.
- **(d) Combination of the above.** Most realistic; pick which event
  closes a session (caller-close OR timeout OR TTL) and document the
  precedence.

### D4 — Schema impact

The current `gif.sessions` table is INSERT-on-create / UPDATE-on-close.
v0.2 will either:
- **(a) Repurpose `sessions`** with new columns for handle, mint event,
  and lifecycle, keeping the table conceptually but changing what a row
  means.
- **(b) Introduce a new table** (e.g., `gif.session_handles`) with the
  new semantics, and migrate v0.1's per-call `sessions` rows out of the
  governance hot path.

Either path produces a numbered migration; the F3 constraint applies to
both.

### D5 — Conformance-test surface

The v0.2 design must expose enough externally observable behavior that
a conformance harness can assert:
- A handle minted by GIF has the documented format and provenance.
- A call carrying a valid handle is accepted; a call carrying an
  unknown, expired, or wrong-persona handle is rejected with a
  documented error code.
- Combination policy accumulation works across calls sharing a handle
  and does not bleed across handles.
- Handle lifecycle events appear in the audit trail in the specified
  order.

The follow-on ADR must specify which behaviors are conformance-required
vs. implementation-defined.

### D6 — Interoperability hooks

Whether to land SEP-414 (`_meta.traceparent`) propagation in the same
v0.2 release. Yes-or-no is a small decision once D2 is chosen; raised
here so it isn't forgotten.

## Migration Constraints

Any specific design in the follow-on ADR must satisfy the following:

### M1 — Numbered migration, additive where possible

Schema changes follow the existing `NNN_*.sql` numbering. The v0.1
`sessions` table is still load-bearing for v0.1 deployments that have
not yet upgraded; the migration should add v0.2 structures alongside
rather than mutating v0.1 structures in place where it can.

### M2 — A v0.1 → v0.2 migration runbook

The cumulative migration narrative lives in
`docs/migrations/v0.1-to-v0.2.md` (skeleton committed in PR #7). The
session-handle change is the largest single entry in that document. It
must cover: schema migration command order, adopter API contract
change, gif-enforcement dependency repin, smoke-test expectations.

### M3 — Adopter API contract change documented in the runbook

Adopters consuming `gif-enforcement` as a versioned git dependency
(GIF-007) must repin to the v0.2 tag and update tool handler call
sites. The exact API delta — what arguments change, what return shape
changes, what errors are new — is documented in the runbook before the
RC tag ships.

### M4 — No silent fallback to v0.1 behavior

If a v0.2 GIF instance receives a call without a session handle, it
must reject the call with a documented error code, not silently mint a
fresh per-call session as v0.1 does. Silent fallback would let adopters
ship v0.2 deployments that pass tests but have no working combination
policy enforcement.

### M5 — RC period before final

The `v0.2.0-rc.1` tag ships once the surface stabilizes; the
`v0.2.0-final` tag ships after RC issues raised by adopters (or by
gif's own dogfooding) are resolved. The follow-on ADR is expected to
land specifics before `v0.2.0-rc.1`; RC-period feedback may produce
amendments before `v0.2.0` final.

## Open Questions

These are explicitly *not* answered here. They are the input to the
v0.2 design pass.

- **OQ1 — Minting point.** Which of D1(a)/(b)/(c)/(d) is correct, and
  what's the deciding factor (round-trip cost vs. lifecycle clarity vs.
  framework-boundary cleanliness)?
- **OQ2 — Propagation channel.** Tool argument vs. `_meta` vs. hybrid
  (D2). What does conformance need to see?
- **OQ3 — Closure semantics.** Caller-close, timeout, TTL, or a
  combination (D3)? What's the audit-trail story for each closure family?
- **OQ4 — Identity-binding interaction.** Does the v0.2 handle change
  anything about GIF-013 or GIF-014, or is it strictly orthogonal? If
  orthogonal, the follow-on ADR should say so explicitly.
- **OQ5 — Contributor session-binding extension.** GIF-014 documents a
  contributor project for structural MCP-session-to-assignment binding.
  Does the v0.2 handle make that extension easier, harder, or
  irrelevant? Should CONTRIBUTING.md be updated when the v0.2 design
  lands?
- **OQ6 — `_meta.traceparent` co-shipping.** Land SEP-414 propagation
  in the same v0.2 release, or defer (D6)?
- **OQ7 — MCP Apps coverage.** How does the v0.2 handle govern
  sandboxed UI iframes (SEP-1865)? Same handle, separate handle, or
  out-of-scope for v0.2?

## Non-Negotiables Touched

- **Combination policy enforcement (GIF-011)** — preserved by F1; any
  design must retain cross-call accumulation.
- **`persona_id` bearer-token model (GIF-013, GIF-014)** — preserved
  by F2; the new handle does not weaken the existing posture and is
  not marketed as closing the runtime-binding gap.
- **Append-only audit trail (GIF-003)** — preserved by F3; lifecycle
  events are INSERT-only.
- **Framework boundary (GIF-012)** — preserved by F5; no in-memory
  session state on the GIF side.
- **Honest-caller seam** — preserved by F6; the handle changes the
  session-identity seam, not the source-declaration seam.

## What This ADR Does Not Decide

- Which option in D1–D6 is chosen.
- The exact name, format, and lifetime of the handle.
- The exact migration numbering and migration scripts.
- Whether `_meta.traceparent` propagation lands in v0.2.0 or later.
- Whether MCP Apps coverage (SEP-1865) is a v0.2 deliverable or a
  follow-on.

All of the above are deferred to the v0.2 design-pass ADR (or to an
amendment promoting this ADR to Accepted with the specifics filled in).

## Cross-references

- GIF-003 (append-only audit trail)
- GIF-007 (versioned git dependency — adopter repin contract)
- GIF-011 (combination policies — the v0.1 mechanism this ADR
  preserves)
- GIF-012 (framework boundary — operational vs. governance)
- GIF-013 (runtime identity accountability — `human_actor_id` posture)
- GIF-014 (`persona_id` bearer-token model — the runtime binding
  posture this ADR must not weaken)
- SEP-2575, SEP-2567 (stateless protocol core — the change this ADR
  responds to)
- SEP-414 (W3C Trace Context — opportunistic interop hook)
- SEP-1865 (MCP Apps — audit/consent coverage)
- SEP-2484 (conformance suite — Final-status gate)
- Issue #8 — tracking issue for the full v0.2 effort
- `docs/migrations/v0.1-to-v0.2.md` — migration narrative
