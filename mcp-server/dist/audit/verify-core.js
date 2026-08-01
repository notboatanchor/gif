/*
 * Copyright 2026 Notboatanchor Labs LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
// src/audit/verify-core.ts
// =============================================================================
// Pure core of the audit chain verifier: canonical-form normalization and
// serialization, per-version preimage assembly, SHA-256 recomputation, and
// partition / anchor / chain verification.
//
// No database dependency. The operator CLI (src/cli/verify_audit_chain.ts)
// provides the DB shell — it fetches rows and delegates here. Tests import
// this module from dist/ so the SHIPPED code, not a replica, is what the
// known-answer digests pin.
//
// Moved verbatim from src/cli/verify_audit_chain.ts, where the CLI's
// top-level execution (argv parse, pool open, process.exit) made the pure
// functions unimportable by any test.
// =============================================================================
import { createHash } from 'crypto';
// ---------------------------------------------------------------------------
// Pure core — no DB dependency; importable by .mjs tests without a build step
// ---------------------------------------------------------------------------
/**
 * Canonical-form string normalization (gif-audit/1 and /2): Unicode NFC, then
 * trim leading/trailing ASCII space (U+0020) only, reject control characters,
 * cap length at 8192. Applied to every protected string value before
 * serialization.
 *
 * Trim charset = U+0020 only, matching the DB trigger's btrim(normalize(x,NFC)).
 * JS `.trim()` strips the full Unicode whitespace set (NBSP, ideographic space,
 * the U+2000–U+200A range, etc.); DB `btrim` strips ASCII space only — so a value
 * with leading/trailing non-control Unicode whitespace would hash one way on emit
 * and another on verify, a false tamper flag. `replace(/^ +| +$/g, '')` pins both
 * sides to U+0020.
 *
 * Guarded against drift by two known-answer tests: test_verify_core.mjs pins
 * THIS shipped canonicalizer (imported from dist/) to the vendor-neutral
 * reference digests, and test_chain_verifier.mjs pins its independent replica
 * to the same values.
 *
 * Parity note: the DB trigger's norm() does NFC + the same U+0020 trim, but does
 * NOT reject control chars or cap length (it must never throw — audit-never-
 * throws). For gif's controlled-vocabulary / persona.purpose inputs the two agree
 * byte-for-byte; a string that trips the control-char/cap throw here is surfaced
 * as `unrecomputable` — it fails verification without being reported as tamper.
 * Making the trigger itself reject what the verifier rejects is a
 * canonical-semantics change gated on an ADR, tracked separately.
 */
export const MAX_FIELD_LEN = 8192;
export function normalizeString(s) {
    // Control characters (C0 + DEL) are not permitted in a protected string field.
    if (/[\u0000-\u001f\u007f]/.test(s)) {
        throw new Error('control character in protected string field');
    }
    // Trim ASCII space (U+0020) only — matches PG btrim; NOT JS .trim() (full
    // Unicode whitespace), which would diverge from the trigger on e.g. NBSP.
    const n = s.normalize('NFC').replace(/^ +| +$/g, '');
    if (n.length > MAX_FIELD_LEN) {
        throw new Error('protected string field exceeds length cap');
    }
    return n;
}
/**
 * Canonicalize (shared by gif-audit/1 and /2): deterministic JSON with keys
 * sorted lexicographically at every level, no insignificant whitespace, strings
 * NFC-normalized + trimmed, null as the literal token `null`, booleans as
 * true/false. The per-version shape is chosen by buildBody / buildBodyV2; this
 * serializer is version-agnostic. Byte-identical to the DB trigger's manual
 * JSON build and to a plain `sha256sum` of the same canonical string.
 */
export function canonicalize(v) {
    if (v === null)
        return 'null';
    if (typeof v === 'boolean')
        return v ? 'true' : 'false';
    if (typeof v === 'number') {
        if (!Number.isFinite(v))
            throw new Error('non-finite number');
        return JSON.stringify(v);
    }
    if (typeof v === 'string')
        return JSON.stringify(normalizeString(v));
    if (Array.isArray(v))
        return '[' + v.map(canonicalize).join(',') + ']';
    if (typeof v === 'object') {
        const o = v;
        const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
        return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(o[k])).join(',') + '}';
    }
    throw new Error('uncanonicalizable value');
}
/**
 * Assemble the gif-audit/1 canonical body for a row (event_hash excluded). Maps
 * gif's stored columns to the canonical keys (persona_id → principal_id,
 * invoked_by_persona_id → invoked_by_principal_id) and pins the constant
 * `caller-governance` profile. Key insertion order is irrelevant — canonicalize
 * sorts every level.
 */
export function buildBody(row, previousHash) {
    return {
        event_id: row.event_id,
        event_type: row.event_type,
        occurred_at: row.occurred_at,
        outcome: row.outcome,
        previous_hash: previousHash,
        principal_id: row.persona_id,
        profile: 'caller-governance',
        profile_data: {
            flagged: row.flagged,
            invoked_by_principal_id: row.invoked_by_persona_id,
            purpose_declared: row.purpose_declared,
            session_id: row.session_id,
        },
        tool_name: row.tool_name,
    };
}
/**
 * Assemble the gif-audit/2 canonical body for a row (event_hash excluded). Maps
 * gif's stored columns to the canonical keys (persona_id → principal_id,
 * invoked_by_persona_id → invoked_by_principal_id) under the single
 * `caller-governance` extension. Key insertion order is irrelevant —
 * canonicalize sorts every level. Must stay byte-identical to the migration-015
 * trigger's manual preimage build.
 */
export function buildBodyV2(row, previousHash) {
    return {
        event_id: row.event_id,
        event_type: row.event_type,
        extensions: {
            'caller-governance': {
                flagged: row.flagged,
                // ?? null on every nullable field: canonicalize() drops undefined keys
                // but the trigger always emits the literal null token (COALESCE), so a
                // hand-built row with an undefined field must coerce to null to stay
                // byte-identical to the trigger. The DB fetch yields null, never
                // undefined, so this is a no-op on the live path.
                invoked_by_principal_id: row.invoked_by_persona_id ?? null,
                purpose_declared: row.purpose_declared ?? null,
                session_id: row.session_id ?? null,
            },
        },
        occurred_at: row.occurred_at,
        outcome: row.outcome,
        previous_hash: previousHash,
        principal_id: row.persona_id,
        tool_name: row.tool_name ?? null,
    };
}
/**
 * Recompute the SHA-256 event_hash for a row in its stored canonical form,
 * selecting the canonicalization rule by the row's own stamped canon_version
 * and using the row's stored previous_hash as the chain link (the value the
 * trigger used). Returns null for an unrecognized canon_version — a row written
 * under a newer/unknown canonical form cannot be re-verified here and must not
 * be reported as tampered (forward-safety). gif-audit/1 rows predate the /2
 * re-cut (migration 015) and still verify under the /1 rule.
 */
export function recomputeHash(row) {
    let preimage;
    if (row.canon_version === 'gif-audit/2') {
        preimage = canonicalize(buildBodyV2(row, row.previous_hash));
    }
    else if (row.canon_version === 'gif-audit/1') {
        preimage = canonicalize(buildBody(row, row.previous_hash));
    }
    else {
        return null;
    }
    return createHash('sha256').update(preimage, 'utf8').digest('hex');
}
/**
 * Verify one month partition's worth of rows.
 *
 * Rows must be ordered by occurred_at ASC, event_id ASC — the same order the
 * trigger uses when selecting the most-recent-in-partition row for chain links.
 *
 * Per-row categories:
 *   - legacy_null:   event_hash IS NULL  → skip verification, count only
 *   - hash_error:    event_hash = 'HASH_ERROR' → write-time sentinel, skip
 *   - uncheckable:    unrecognized canon_version → cannot recompute, NOT tamper
 *                     (forward-safety, informational)
 *   - unrecomputable: recognized canon_version, normalization rejection →
 *                     unverifiable row, fails verification (not reported as tamper)
 *   - hashed:         64-char hex event_hash → recompute + linkage check
 */
export function verifyPartition(partitionKey, rows) {
    const result = {
        partition: partitionKey,
        total_rows: rows.length,
        hashed_checked: 0,
        links_verified: 0,
        mismatches: [],
        breaks: [],
        hash_errors: [],
        uncheckable: [],
        unrecomputable: [],
        legacy_null: 0,
    };
    // prevHashedRow tracks the most recent row with a valid (non-sentinel) hash,
    // for linkage checking.
    let prevHashedHash = null;
    let isFirstHashed = true;
    for (const row of rows) {
        if (row.event_hash === null) {
            result.legacy_null++;
            continue;
        }
        if (row.event_hash === 'HASH_ERROR') {
            result.hash_errors.push(row.event_id);
            // HASH_ERROR rows advance the chain pointer: the trigger writes 'HASH_ERROR'
            // as event_hash, so the next row's trigger will SELECT 'HASH_ERROR' as
            // prev_hash and store it in that row's previous_hash. The linkage check for
            // the next real hashed row must therefore compare against 'HASH_ERROR'.
            prevHashedHash = 'HASH_ERROR';
            isFirstHashed = false;
            continue;
        }
        // This is a real hashed row. Attempt to recompute its canonical hash.
        // Two distinct cannot-recompute causes get opposite treatment: an
        // unrecognized canon_version (recomputeHash → null) is forward-safety —
        // informational `uncheckable` — while a normalization rejection (throw)
        // on a RECOGNIZED version is an unverifiable row in a tamper-evidence
        // chain — `unrecomputable`, which fails verification. Neither is
        // reported as tamper.
        let expected = null;
        let normalizationRejected = false;
        try {
            expected = recomputeHash(row);
        }
        catch {
            normalizationRejected = true;
        }
        if (expected === null) {
            (normalizationRejected ? result.unrecomputable : result.uncheckable).push(row.event_id);
            prevHashedHash = row.event_hash;
            isFirstHashed = false;
            continue;
        }
        result.hashed_checked++;
        // Recompute check: does the stored event_hash match the trigger's preimage?
        if (expected !== row.event_hash) {
            result.mismatches.push(row.event_id);
            // Still advance the linkage pointer so downstream rows aren't false-flagged.
            prevHashedHash = row.event_hash;
            isFirstHashed = false;
            continue;
        }
        // Linkage check: previous_hash must equal the prior hashed row's event_hash.
        // The first hashed row in a partition must have previous_hash = NULL.
        if (isFirstHashed) {
            if (row.previous_hash !== null) {
                // First hashed row has a non-null previous_hash — chain started mid-stream
                // or HASH_ERROR rows caused the first hash to link to something we skipped.
                // Only flag if it doesn't match anything (truly orphaned).
                // Design choice: we don't flag this case — a HASH_ERROR or legacy-null
                // predecessor can cause the first real-hash row to have a non-null
                // previous_hash. Accept it as informational.
            }
            result.links_verified++;
            isFirstHashed = false;
        }
        else {
            if (row.previous_hash === prevHashedHash) {
                result.links_verified++;
            }
            else {
                result.breaks.push(row.event_id);
            }
        }
        prevHashedHash = row.event_hash;
    }
    return result;
}
/**
 * Verify anchor rows against live partition data.
 *
 * liveHashLookup: event_id → current event_hash
 * liveCountLookup: partition_name → current row count
 */
export function verifyAnchors(anchors, liveHashLookup, liveCountLookup) {
    return anchors.map(anchor => {
        const liveHash = liveHashLookup.get(anchor.event_id);
        const liveCount = liveCountLookup.get(anchor.partition_name) ?? 0;
        if (liveHash === undefined) {
            return {
                anchor_id: anchor.anchor_id,
                event_id: anchor.event_id,
                partition_name: anchor.partition_name,
                anchored_by: anchor.anchored_by,
                status: 'event_not_found',
                detail: `event_id ${anchor.event_id} not found in live audit_events`,
            };
        }
        if (liveHash !== anchor.anchor_hash) {
            return {
                anchor_id: anchor.anchor_id,
                event_id: anchor.event_id,
                partition_name: anchor.partition_name,
                anchored_by: anchor.anchored_by,
                status: 'hash_mismatch',
                detail: `stored anchor_hash ${anchor.anchor_hash} ≠ live event_hash ${liveHash ?? 'NULL'}`,
            };
        }
        if (liveCount < anchor.event_count) {
            return {
                anchor_id: anchor.anchor_id,
                event_id: anchor.event_id,
                partition_name: anchor.partition_name,
                anchored_by: anchor.anchored_by,
                status: 'shrunk',
                detail: `live row count ${String(liveCount)} < anchored count ${String(anchor.event_count)} — possible deletion`,
            };
        }
        return {
            anchor_id: anchor.anchor_id,
            event_id: anchor.event_id,
            partition_name: anchor.partition_name,
            anchored_by: anchor.anchored_by,
            status: 'ok',
            detail: 'anchor hash matches and row count has not shrunk',
        };
    });
}
/**
 * Pure aggregate: given already-fetched, grouped rows and optional anchor data,
 * return a structured verification result.
 *
 * partitionMap: month key (ISO string) → ordered rows
 * anchors:      null when --check-anchors was not requested
 * liveHashLookup / liveCountLookup: required when anchors is non-null
 */
export function verifyChain(partitionMap, anchors, liveHashLookup, liveCountLookup) {
    const partitions = [];
    for (const [key, rows] of partitionMap) {
        partitions.push(verifyPartition(key, rows));
    }
    const anchorResults = anchors !== null && liveHashLookup && liveCountLookup
        ? verifyAnchors(anchors, liveHashLookup, liveCountLookup)
        : null;
    const total_mismatches = partitions.reduce((s, p) => s + p.mismatches.length, 0);
    const total_breaks = partitions.reduce((s, p) => s + p.breaks.length, 0);
    const total_hash_errors = partitions.reduce((s, p) => s + p.hash_errors.length, 0);
    const total_uncheckable = partitions.reduce((s, p) => s + p.uncheckable.length, 0);
    const total_unrecomputable = partitions.reduce((s, p) => s + p.unrecomputable.length, 0);
    const total_anchor_fails = anchorResults
        ? anchorResults.filter(a => a.status !== 'ok').length
        : 0;
    return {
        partitions,
        anchors: anchorResults,
        total_mismatches,
        total_breaks,
        total_hash_errors,
        total_uncheckable,
        total_unrecomputable,
        total_anchor_fails,
        ok: total_mismatches === 0 && total_breaks === 0 && total_anchor_fails === 0 &&
            total_unrecomputable === 0,
    };
}
//# sourceMappingURL=verify-core.js.map