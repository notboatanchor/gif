# GIF-020 — Session Closure Semantics

**Status:** Accepted
**Date:** 2026-05-23

## Decision

The v0.2 governance session (`gif_session_id`, minted by `session_start` per
GIF-019) ends by one of two mechanisms:

1. **Explicit caller-close.** A new MCP tool, `session_close`, lets the
   adopter mark a session ended. It validates the asserted `persona_id`,
   sets `gif.sessions.ended_at = now()`, and INSERTs a `session_close`
   audit event.

2. **Hard wall-clock TTL.** A deployment-wide TTL — set via the
   `GIF_SESSION_TTL_SECONDS` environment variable, default `86400`
   (24 hours) — bounds session lifetime from `gif.sessions.created_at`.
   Enforcement is **lazy**: every governed call checks the session row
   on the way through; a call that lands when `now() > created_at + TTL`
   is rejected and emits a `session_expired` audit event.

There is no inactivity timeout in v0.2.0, no background sweeper, and no
per-persona TTL. The first is deferred for the reasons in §Consequences;
the others are deferred per §What This ADR Does Not Decide.

This ADR locks D3 (lifetime and closure semantics) and a thin slice of
D4 (the existing `gif.sessions.ended_at` column is reused; the broader
repurpose-vs-new-table decision remains open). Closure precedence,
audit-event types, and the lazy-expiry contract are all specified
below; the corresponding wire-level error codes are part of the
v0.2.0-rc.1 implementation surface and may be revised in RC feedback.

## Context

GIF-018 scoped the v0.2 problem; GIF-019 locked the mint point
(`session_start` MCP tool) and the propagation channel (explicit
`gif_session_id` argument on every governed tool's `inputSchema`).
GIF-019 explicitly deferred D3:

> Lifecycle (closure, timeout, TTL) is **not specified by this ADR.**
> The follow-on ADR addressing D3/OQ3 will define when and how a
> session ends. Until that ADR lands, sessions remain open after
> `session_start`.

This is that follow-on ADR.

### What `gif.sessions` already supports

The `sessions` table (`schema/001_gif_core.sql`) was provisioned with
the closure shape this ADR needs:

```sql
session_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
persona_id   UUID NOT NULL REFERENCES personas(persona_id),
started_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
ended_at     TIMESTAMP WITH TIME ZONE,    -- null while session is active
invocation_context JSONB
```

`_closeSession()` at `mcp-server/src/enforcement.ts:333-343` already
performs `UPDATE sessions SET ended_at = now() WHERE session_id = $1`
and is structured noexcept (catches its own errors, logs to stderr,
never throws into the tool response path).

The semantic shift introduced here is **who calls `_closeSession()`
and when.** In v0.1's dispatch (`mcp-server/src/index.ts:118-157`),
the dispatcher itself called `_closeSession()` immediately after the
audit event for every tool call. v0.2 stops calling it from the
dispatcher (per GIF-019 §Dispatch flow step 6) and routes it through
the new `session_close` tool handler.

### Why this closure family, and not the others

The design space (GIF-018 §D3) lists four options. The choice across
them is constrained by F3, F5, and F7:

- **F5 (stateless dispatch on GIF side)** rules out any closure
  mechanism that requires either a background sweeper process or
  in-memory per-session state on the GIF process. This eliminates
  inactivity-timeout designs that maintain a `last_seen_at` watermark
  and run a sweeper on a timer.
- **F3 (append-only audit trail)** allows `sessions.ended_at` to be
  UPDATEd as a denormalization, but the authoritative record of
  closure must be derivable from `audit_events` (INSERT-only). The
  `session_close` and `session_expired` event types satisfy this.
- **F7 (conformance load-bearing)** prefers an externally observable,
  schema-asserted closure surface. Caller-close is asserted via a
  `tools/list` entry. TTL expiry is asserted via the documented
  rejection-and-audit behavior. An inactivity sweeper's effect is
  asserted only via timing-dependent test cases.

A pure caller-close design (D3(a)) was considered. It is simpler but
leaves leaked or forgotten handles accumulating combination-policy
sources indefinitely — the "bounded blast radius" posture of a TTL is
absent. A v0.2 deployment with caller-close-only could be governed
correctly in principle and badly in practice. Hard TTL closes that
gap at minimum spec surface.

A full combination (D3(d)) including inactivity timeout adds a third
mechanism callers must reason about and either requires a sweeper
(F5 friction) or a per-call write to a `last_activity_at` column
(write amplification on every governed call). The marginal benefit
over caller-close-plus-TTL is not load-bearing for v0.2.0 and
introduces conformance-test surface that may need to change in RC.

## Forces Satisfied

The forces F1–F9 are stated in GIF-018 and GIF-019. This ADR
addresses each:

- **F1 (combination policy preserved):** Combination accumulation
  remains scoped to a single `gif_session_id`. Closure ends that scope
  cleanly. A new session means a new accumulation window — by
  construction, not by accident.
- **F2 (bearer-token model not weakened):** `session_close` validates
  `persona_id` against the session row's owner before closing. A
  caller holding a `gif_session_id` for a session it did not start
  cannot close it. Lazy-expiry rejection on the dispatch path
  similarly verifies persona ownership before the closed/expired
  check, so the existing F2 posture is unchanged.
- **F3 (append-only audit trail):** Closure produces INSERT-only
  audit events (`session_close`, `session_expired`). The
  `sessions.ended_at` UPDATE is a denormalized cache; closure facts
  are recoverable from `audit_events` alone.
- **F4 (breaking adopter contract, written explicitly):** Adopters
  gain one tool (`session_close`), one env var
  (`GIF_SESSION_TTL_SECONDS`), and two new error-handling paths
  (closed handle, expired handle). The contract delta lands in
  `docs/migrations/v0.1-to-v0.2.md`.
- **F5 (stateless dispatch on GIF side):** No background sweeper, no
  in-memory state. Expiry is computed per call from
  `sessions.created_at + GIF_SESSION_TTL_SECONDS` versus `now()`.
  Closure is computed per call from `sessions.ended_at IS NOT NULL`.
- **F6 (honest-caller seam unchanged):** The caller-close mechanism
  trusts the caller to call `session_close` when their logical work
  is done. This is the same honest-caller posture that already
  governs `incomingSourceRefs`; nothing new is asserted about caller
  honesty by this ADR.
- **F7 (conformance load-bearing):** `session_close` is a
  `tools/list`-visible MCP tool; a conformance harness can call it
  and assert audit-event emission. TTL expiry is conformance-testable
  by minting a session, manipulating system time or `created_at` in
  the test rig, and asserting the documented rejection-and-audit
  behavior.
- **F8 (opportunistic interoperability):** Unchanged from GIF-019.
- **F9 (forward-compatibility with SEP-1299):** Unchanged from
  GIF-019. Closure is application-layer governance state; SEP-1299
  client continuity is transport-layer. Independent surfaces.

## Adopter Contract

### New MCP tool: `session_close`

```
Input:
  persona_id        string   required
  gif_session_id    string   required

Output:
  closed            boolean   // true on success

Behavior:
  - Validates persona via _validatePersona (returns PersonaInvalidReason
    on failure).
  - Looks up the session by gif_session_id.
  - Rejects if the session does not exist, does not belong to the
    asserted persona_id, or is already closed.
  - Sets gif.sessions.ended_at = now().
  - INSERTs a session_close audit event linked to the session_id.
  - Returns { closed: true }.

Marked skipSession=true (the call does not itself require a session
to be open).
```

`session_close` is idempotent-by-rejection: a second close of an
already-closed session is rejected (`SESSION_ALREADY_CLOSED`), not
treated as a no-op. The rejection itself emits an audit event so the
attempt is recorded.

### New environment variable: `GIF_SESSION_TTL_SECONDS`

```
Name:     GIF_SESSION_TTL_SECONDS
Default:  86400  (24 hours)
Units:    seconds (integer)
Scope:    deployment-wide; same TTL applies to every persona's sessions
Read at:  process startup
```

The variable joins the contract documented in `docs/secrets.md`
(per GIF-017) as a non-secret configuration value. Deployments that
need a different TTL set the env var at process start; deployments
that need the default omit it.

A future ADR may introduce per-persona TTL overrides (additive — a
new column or table, with NULL meaning "use the deployment default").
v0.2.0 does not ship that surface.

### Dispatch flow updates

For every governed call (the `skipSession=false` path), the
dispatcher's existing GIF-019 sequence gains two checks between
"persona validated" and "execute tool handler":

1. Validate persona (`_validatePersona`, unchanged).
2. Look up `gif_session_id` from `args`.
3. **Check session ownership and state** (this ADR):
   - Verify the session exists and belongs to the asserted
     `persona_id` (GIF-019, unchanged).
   - If `sessions.ended_at IS NOT NULL`: reject with
     `SESSION_CLOSED`; emit a `session_rejected_closed` audit event;
     return.
   - Else if `now() > sessions.created_at + GIF_SESSION_TTL_SECONDS`:
     reject with `SESSION_EXPIRED`; emit a `session_expired` audit
     event; return.
4. Execute the tool handler with the validated `sessionId`.
5. Log the tool's audit event linked to `sessionId`.
6. **Do not close the session** (GIF-019, unchanged).

The session-state check is **one SELECT** on the existing `sessions`
row (which the dispatcher is already reading in step 3 for the
GIF-019 ownership check). It does not add an extra round-trip.

### Closure precedence

When both closed and expired conditions could apply to the same
session row:

1. **Closed wins.** A session with `ended_at IS NOT NULL` is
   `SESSION_CLOSED` regardless of TTL. The audit event records the
   actual closure (caller-close happened at a specific time;
   expiration is a derived condition).
2. Otherwise, TTL wins if applicable.
3. Otherwise, accept.

This precedence is observable and testable from outside: a session
closed at T=1h with TTL=24h is `SESSION_CLOSED`, not
`SESSION_EXPIRED`, on a call at T=25h.

### Audit-event types

Three new event types are introduced:

| Event type | Emitted by | Trigger |
|---|---|---|
| `session_close` | `session_close` tool handler | Successful caller-driven close. |
| `session_expired` | Dispatcher | Lazy detection of TTL expiry on a governed call. |
| `session_rejected_closed` | Dispatcher | Call presents a handle whose session is already closed. |

All three are INSERT-only rows in `audit_events`, using existing
columns. No schema change is required for this ADR. Per the
audit-never-throws non-negotiable, the dispatcher's emission of
`session_expired` and `session_rejected_closed` is best-effort: a
failed INSERT does not turn the rejection response into a different
response. The rejection still propagates to the caller.

### What does NOT change

- The persona bearer-token model (GIF-013, GIF-014).
- The honest-caller seam on `incomingSourceRefs` (GIF-011 §6.5.5).
- The framework boundary (GIF-012). `session_close` is a governance
  dispatch point, not an operational hook.
- GIF-019's mint contract and the `gif_session_id` propagation
  surface.
- The `gif.sessions` table schema — no migration introduced by this
  ADR.

## Audit-Trail Story

The three closure paths produce three audit-trail shapes. Each is
recoverable from `audit_events` and `sessions` alone:

### Path 1 — Caller-close

1. `session_start` event at T0 (GIF-019).
2. N governed tool events between T0 and Tc, all linked to the same
   `session_id`.
3. `session_close` event at Tc.
4. `sessions.ended_at = Tc` (denormalization).

Auditing: the session ran from T0 to Tc with the listed governed
events; closure was explicit.

### Path 2 — Lazy TTL expiry on next call

1. `session_start` event at T0.
2. N governed tool events between T0 and the last governed event Tn.
3. No further governed events for a while.
4. At T0 + TTL, the session is expired in principle but no event is
   emitted (no background work happens).
5. The next call at some Tr > T0 + TTL is rejected; a
   `session_expired` event is INSERTed at Tr.
6. `sessions.ended_at` remains NULL (no UPDATE — the rejection path
   does not modify the sessions row).

Auditing: the session was usable from T0 to T0 + TTL; the
`session_expired` event at Tr records the first rejected reuse
attempt. Earlier rejected attempts (if any between T0 + TTL and Tr)
would each have their own `session_expired` row.

### Path 3 — Silent dormancy (TTL elapses, no further calls)

1. `session_start` event at T0.
2. N governed tool events between T0 and the last governed event Tn.
3. No further calls — ever.
4. The session is expired in principle from T0 + TTL onward.
5. **Zero closure audit events are emitted.**
6. `sessions.ended_at` remains NULL.

Auditing: the session's effective lifetime is recoverable as
`[T0, T0 + GIF_SESSION_TTL_SECONDS]`. The auditor knows TTL from the
deployment configuration; the session row gives `created_at`; the
absence of a `session_close` or `session_expired` row for that
`session_id` distinguishes this case from Paths 1 and 2.

This is a deliberate property under F5: emitting a closure event in
this case would require a sweeper. The auditor's reconstruction logic
must handle it, and the v0.1-to-v0.2 migration runbook documents the
pattern.

### Path 4 — Caller-close after a call that was already rejected

If a caller tries to `session_close` a session that was already
rejected on a prior call as `SESSION_EXPIRED`, the `session_close`
handler does not introspect prior rejection events; it checks the
sessions row. Because the rejection path does not modify
`sessions.ended_at`, `session_close` at this point sets `ended_at`
successfully and emits a `session_close` event. The audit trail
contains both `session_expired` (the rejection) and `session_close`
(the explicit close), in that temporal order, both linked to the
same `session_id`.

This is acceptable: both events are factual records of what
happened. The auditor's narrative is "this session expired at the
first reuse attempt at Tr, then was explicitly closed by the caller
at Tc>Tr."

## Consequences

### C1 — Mid-workflow false negatives on combination policy

A long-running adopter workflow that crosses a TTL boundary (e.g.,
30-hour batch with default 24h TTL) sees its accumulated combination
sources reset across the implicit handle change. A combination
policy that would have fired at hour 32 — had accumulation continued
— does not fire under v0.2.0. This is intentional: GIF-019 already
states "combination policy accumulation does not bleed across
handles" as a conformance assertion, and TTL is a forcing function
for that property.

The mitigation is deployment-side: set `GIF_SESSION_TTL_SECONDS`
above the longest realistic workflow duration. The 24h default
covers most interactive and short-batch use; longer workflows
require explicit configuration.

### C2 — Adopter footgun: auto-renew helpers

An adopter who wraps `gif_session_id` in a "session manager" that
auto-mints on `SESSION_EXPIRED` silently loses combination
accumulation across the renewal boundary. Their workflow appears
governed end-to-end; under the hood, each TTL boundary is a fresh
policy scope.

This is structural, not a bug in v0.2.0. The v0.1-to-v0.2 migration
runbook documents the property and recommends explicit
`session_start` calls at workflow boundaries the adopter intends as
policy boundaries. A v0.2.0-rc conformance assertion can detect
adopter-side auto-renew by asserting that combination accumulation
across distinct handles is observably zero.

### C3 — Silent dormancy in the audit trail

TTL-expired sessions that are never reused generate **no** closure
audit events. Their effective lifetime is recoverable via arithmetic
on `created_at` and the deployment TTL, but a reader scanning
`audit_events` alone for closure events will not see one. This is by
design under F5 (no background sweeper); auditors who need an
end-of-session marker must use the `sessions` row, not
`audit_events` alone.

The v0.1-to-v0.2 migration runbook documents the audit-trail
reconstruction pattern so operators and auditors know to compute
`expired_at = created_at + TTL` for sessions with `ended_at IS NULL`
and no `session_close` / `session_expired` event.

### C4 — Cliff-edge expiry mid-tool-call

There is no grace period and no renewal flow. A governed call
landing one second past TTL is rejected with `SESSION_EXPIRED`; any
work-in-progress on the caller side is the caller's problem. A
future ADR may introduce a renewal mechanism (e.g., a
`session_extend` tool with policy-controlled rules); v0.2.0 does
not.

The mitigation for callers is to call `session_start` again and
re-thread the new `gif_session_id`. Because GIF-019 separates the
mint operation from the work operations, this is cheap.

### C5 — Global TTL, not per-persona

One TTL applies to every persona in a deployment. A high-trust
persona running long batches and a low-trust persona running short
interactive sessions share the knob. The v0.2.0 design accepts this
because:

- No adopter has yet reported a need to stratify TTL by persona.
- Per-persona TTL adds schema, governance-UX, and conformance
  surface for a speculative feature.
- The defer is cheap: a future ADR can add per-persona TTL
  additively (NULL or absent override → deployment default;
  presence → override). v0.2.0's contract does not foreclose it.

### C6 — Close-failure modes

Both `session_close` (caller path) and the dispatcher's
expired/closed-rejection emissions are noexcept. A failed `UPDATE
sessions SET ended_at = now()` in the caller-close path logs to
stderr (matching `_closeSession()`'s existing behavior) and returns
a non-success response shape — but the failure mode is database
unavailability, which would have already blocked persona validation
and produced a clearer earlier error. Audit-event INSERT failures
on the rejection path follow the existing audit-never-throws
contract.

## Migration Path

Per M1, M2, and M3 (GIF-018), the v0.1 → v0.2 migration runbook
gains the following entries in
`docs/migrations/v0.1-to-v0.2.md`:

1. **Schema:** None required by this ADR. The existing
   `sessions.ended_at` column carries the closure denormalization.
   D4's broader repurpose-vs-new-table decision remains open.
2. **Environment:** Adopters may set
   `GIF_SESSION_TTL_SECONDS` in their deployment environment; the
   default (86400) applies if unset.
3. **Host code:** Adopters that have long-running logical sessions
   call `session_close` at logical session end. Adopters whose
   sessions are short-lived may skip the explicit close and let TTL
   reclaim them; the audit trail reflects which pattern the adopter
   uses.
4. **Error handling:** Adopters handle two new error codes on
   governed calls: `SESSION_CLOSED` (handle was explicitly closed)
   and `SESSION_EXPIRED` (handle aged out under TTL). The
   recommended response is to `session_start` again and re-thread
   the new handle.
5. **Audit-trail reconstruction:** Auditors and downstream
   integrations are advised that `sessions.ended_at IS NULL` does
   not imply "session still active" — combine with `created_at +
   GIF_SESSION_TTL_SECONDS` to determine effective expiry for the
   silent-dormancy case (Path 3 above).
6. **Smoke-test expectations:** Adopter smoke tests that exercise
   `session_close` and TTL-expiry paths should assert the new audit
   event types appear in `audit_events`.

## What This ADR Does Not Decide

- **Inactivity timeout.** Deliberately not in v0.2.0. May land in a
  future ADR if adopter signal emerges and a sweeper-free
  implementation is identified.
- **Per-persona TTL.** Deliberately not in v0.2.0 for the reasons
  in C5. Additive in a future ADR.
- **D4 — broader schema impact.** Whether to keep `gif.sessions` as
  the single closure-tracking table or introduce a separate
  `session_handles` / `session_lifecycle_events` table. This ADR
  uses the existing column in place; D4 may revise.
- **D5 — conformance-surface specifics.** This ADR creates
  conformance-testable behavior; the precise specification of which
  behaviors a conformance harness must assert remains a separate
  deliverable.
- **Renewal / grace period.** No `session_extend` tool, no
  TTL-renewal flow in v0.2.0. Future ADR if needed.
- **Wire-level error code shape.** The audit event types
  (`session_expired`, `session_rejected_closed`) are locked. The
  exact wire-level error codes returned to the caller
  (`SESSION_EXPIRED`, `SESSION_CLOSED`, etc.) ship with v0.2.0-rc.1
  and may be revised on RC feedback.
- **Idempotency of `session_close` response shape.** The ADR
  specifies rejection on double-close. Whether the rejection-side
  response carries the original close timestamp or only an error is
  an implementation detail for v0.2.0-rc.1.

## Non-Negotiables Touched

- **Combination policy enforcement (GIF-011):** preserved by F1;
  closure bounds the accumulation window cleanly.
- **`persona_id` bearer-token model (GIF-013, GIF-014):** preserved
  by F2; persona ownership is verified before close and before
  closed/expired checks.
- **Append-only audit trail (GIF-003):** preserved by F3; closure
  events are INSERT-only; `sessions.ended_at` is a denormalization,
  not the authoritative record.
- **Framework boundary (GIF-012):** preserved by F5; no in-memory
  session state, no background sweeper. Closure is computed from
  data the dispatcher already reads.
- **Audit-never-throws:** preserved; both `session_close` and the
  dispatcher's rejection-side emissions are noexcept.
- **Honest-caller seam (GIF-011 §6.5.5):** unchanged by this ADR.

## Cross-references

- GIF-003 — Append-only audit trail
- GIF-011 — Combination policies (the v0.1 mechanism whose
  accumulation window this ADR bounds)
- GIF-012 — Framework boundary
- GIF-013 — Runtime identity accountability
- GIF-014 — `persona_id` bearer-token model
- GIF-017 — Secrets via environment variables (the env-var
  contract this ADR extends with the non-secret
  `GIF_SESSION_TTL_SECONDS`)
- GIF-018 — Stateless MCP session handles (scoping ADR; this
  ADR closes D3 / OQ3)
- GIF-019 — Session handle: mint point and propagation (the ADR
  whose deferred closure semantics this ADR specifies)
- SEP-2575, SEP-2567 — Stateless protocol core in the MCP
  2026-07-28 Specification Release Candidate
- SEP-2484 — Conformance suite (Final-status gate driving F7)
- Issue #8 — Tracking issue for the full v0.2 effort
- `docs/migrations/v0.1-to-v0.2.md` — Migration narrative
