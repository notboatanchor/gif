# Tamper-Evident Audit Record Contract — conformance vectors

This is the off-wire conformance vector set for the **Tamper-Evident Audit Record
Contract** — record/verifier vectors (not wire-protocol scenarios) providing the
machine-checkable evidence SEP-2484 requires for Final. It packages a built and
tested audit guarantee as a **vendor-neutral** contract — no Postgres, no
gif-specific schema — so any implementation, in any profile, can be checked
against it.

The companion SEP — the *Tamper-Evident Audit Record Contract* — is submitted to
the MCP SEP process (`modelcontextprotocol/modelcontextprotocol`, `seps/`); it is
the authoritative home for the contract text and the sealed known-answer values.

**Status:** `gif-audit/2` — the **`extensions` keyed object** shape. Sorted-JSON
canonicalization aligned with PR #2809, `purpose_declared` inside the chain,
runtime-security registered from its implementer's normative text,
attested-but-structured verification.

## What's here

| File | Role |
|------|------|
| `audit-record-contract.ts` | Reference verifier — core skeleton + typed-extension mechanism (`extensions` keyed object), sorted-JSON canonicalization (NFC/trim/length-cap/no-control-chars), SHA-256 hash chain, verification, and the attestation-manifest validator. No storage / no append-only enforcement (that is attested). |
| `vectors.ts` | Conformance vectors C-REC-1…7, input→expected style. Includes **two fixed known-answer tests** (single-extension + two-extension) for cross-implementation hash interop. |
| `run.ts` | Zero-dependency runner. |

## Run

```
node --experimental-strip-types run.ts   # Node >= 22.6, zero dependencies
# or, from the mcp-server/ package:
npm run vectors
# or with tsx:
npx tsx run.ts
```

Expected: `23 vectors — 23 passed, 0 failed`.

## The architecture (load-bearing)

**Minimal protected core + typed extensions.** Every record carries an
emitter-neutral core (`event_id, occurred_at, principal_id, event_type,
tool_name, outcome, previous_hash, event_hash`). Layer-specific context lives in
`extensions`, a JSON object keyed by registered type id, canonicalized into the
**same preimage** as the core — so extension fields are integrity-protected by
the **one** chain construction. A single record can carry MORE THAN ONE extension
(the two-extension KAT). New emitter types add an extension, not a new chain.

- `caller-governance` is the worked extension (gif's): `purpose_declared`
  REQUIRED and chained, plus `session_id`, `invoked_by_principal_id`, etc.
- `runtime-security` is registered from its implementer's normative text
  (`drift_status` / `severity` / `quarantine_decision` / `policy_id` REQUIRED,
  `evidence_hash` OPTIONAL); `admission-control` is **named** (PR #2624 / PR
  #2809). `V-REC6-*` proves a runtime-security record chains under the same
  construction, and that two extensions hash side by side under one digest.

## The conformance boundary

- **Machine-checkable (these vectors):** core schema + extension validity (C-REC-1),
  canonical-form determinism/injectivity/normalization (C-REC-2), hash correctness
  + KAT (C-REC-3), chain threading + tamper detection incl. extension-field tamper
  (C-REC-4), emission completeness (C-REC-5), emitter-neutral extension mechanism +
  multi-extension records (C-REC-6), **attestation-manifest structure** (C-REC-7).
- **Attested-but-structured (not wire-observable):** the append-only *enforcement*
  of §2.5 is declared in the attestation manifest (§2.7) and re-verifiable over an
  exported record set. The vectors verify its *consequence* (verification fails
  after an out-of-band mutation — `V-REC4-tamper-*`) and the *structure* of the
  attestation (`V-REC7-*`), not the storage mechanism. Bare "trust us" attestation
  is non-conformant (`V-REC7-manifest-bare`).

## Known-answer tests (cross-impl interop)

`KAT_HASH_CG` (single-extension caller-governance) and `KAT_HASH_2X`
(two-extension) in `vectors.ts` are fixed SHA-256 digests over the sorted-JSON
canonical form, reproducible independently. The **single-extension** companion:

```
printf '%s' '{"event_id":"99999999-9999-9999-9999-999999999999","event_type":"tool_call","extensions":{"caller-governance":{"flagged":false,"invoked_by_principal_id":null,"purpose_declared":"reconcile June invoices","session_id":"55555555-5555-5555-5555-555555555555"}},"occurred_at":"2026-06-06T12:00:00.000Z","outcome":"deferred","previous_hash":null,"principal_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","tool_name":"export"}' | sha256sum
# -> d494769c1ae442ea88dd190068747abf63c0568a3b856f85791b1a50a99d48b4
```

The **two-extension** KAT (one record carrying both `caller-governance` and
`runtime-security` side by side under one digest) is sealed spec-side in the
public SEP — preimage + `f733fed9…` there; this matrix pins the same value.

This is the same canonical form PR #2809's clearance assertion uses (sorted-key
JSON), so the two record types share one canonicalizer and one vector matrix.
Timestamps are pinned to **RFC 3339 with millisecond precision and `Z`** (the
`Date.toISOString()` form) so the digest is reproducible across implementations.

gif's Postgres trigger reproduces the **single-extension** digest `d494769c…`
byte-for-byte (migration 015, `canon_version = gif-audit/2`) — its own self-test,
via stock `sha256sum` and gif's own canonicalizer. The **two-extension**
`f733fed9…` is reproduced by the canonicalizer here, over the published preimage,
and pinned by this vector set. gif's own multi-extension test exercises the same
hashing *rule* synthetically — with a neutral `x-test-extension`, pinning a
**different** digest — and its live trigger emits a single extension, so neither
reproduces `f733fed9…` itself. The authoritative KAT value lives spec-side (the
public SEP); gif holds a verified self-test copy of the single-extension value and
reproduces it from the rule, per the KAT-ownership decision.

## Resolved in review (was: open questions)

- **O1 — protected field set.** RESOLVED: `purpose_declared` is REQUIRED in the
  caller-governance extension and **inside the chain**. `V-REC2-injective-extension`
  and `V-REC4-tamper-purpose` prove it: rewriting the stated reason post-hoc breaks
  verification.
- **O2 — canonical form.** RESOLVED: sorted-key JSON aligned with PR #2809.
- **conformance-surface fork.** RESOLVED: attested-but-structured (the manifest).

## Relationship to the SEP

These vectors are the runnable conformance artifact the SEP's Reference
Implementation / Conformance sections link to: clone this repo, run one command,
see `23 vectors — 23 passed, 0 failed`. The SEP document carries the authoritative
contract text and the sealed known-answer values; this suite proves they run.
Apache-2.0, © Notboatanchor Labs LLC, cross-referencing PR #2809 + PR #2624.
