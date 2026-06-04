/**
 * A single row as fetched from Postgres, shaped for canonical-form hashing.
 * `occurred_at` is fetched via the SAME to_char(...'MS'...) expression the
 * trigger uses, so verifier and trigger consume an identical timestamp string
 * by construction. `flagged` is a real boolean (the canonicalizer needs
 * true/false, not "true"/"false").
 */
export interface AuditRow {
    event_id: string;
    occurred_at: string;
    persona_id: string;
    session_id: string | null;
    event_type: string;
    tool_name: string | null;
    outcome: string;
    flagged: boolean;
    purpose_declared: string | null;
    invoked_by_persona_id: string | null;
    canon_version: string;
    event_hash: string | null;
    previous_hash: string | null;
}
/** The gif-audit/1 canonical body (the hash preimage source; event_hash excluded). */
export interface CanonicalBody {
    event_id: string;
    event_type: string;
    occurred_at: string;
    outcome: string;
    previous_hash: string | null;
    principal_id: string;
    profile: string;
    profile_data: {
        flagged: boolean;
        invoked_by_principal_id: string | null;
        purpose_declared: string | null;
        session_id: string | null;
    };
    tool_name: string | null;
}
/** A single row from gif.audit_chain_anchors. */
export interface AnchorRow {
    anchor_id: string;
    event_id: string;
    anchor_hash: string;
    partition_name: string;
    event_count: number;
    anchored_by: string;
}
/** Per-partition verification result. */
export interface PartitionResult {
    partition: string;
    total_rows: number;
    hashed_checked: number;
    links_verified: number;
    mismatches: string[];
    breaks: string[];
    hash_errors: string[];
    uncheckable: string[];
    legacy_null: number;
}
/** Anchor verification result. */
export interface AnchorResult {
    anchor_id: string;
    event_id: string;
    partition_name: string;
    anchored_by: string;
    status: 'ok' | 'hash_mismatch' | 'shrunk' | 'event_not_found';
    detail: string;
}
/** Top-level result returned by verifyChain(). */
export interface ChainVerifyResult {
    partitions: PartitionResult[];
    anchors: AnchorResult[] | null;
    total_mismatches: number;
    total_breaks: number;
    total_hash_errors: number;
    total_uncheckable: number;
    total_anchor_fails: number;
    ok: boolean;
}
/**
 * Canonical-form string normalization (gif-audit/1): Unicode NFC + trim, reject
 * control characters, cap length at 8192. Applied to every protected string
 * value before serialization.
 *
 * Guarded against drift by the known-answer test in test_chain_verifier.mjs,
 * which pins this canonicalizer to the vendor-neutral reference vectors.
 *
 * Parity note: the DB trigger's norm() does NFC + trim but does NOT reject
 * control chars or cap length (it must never throw — audit-never-throws). For
 * gif's controlled-vocabulary / persona.purpose inputs the two agree byte-for-
 * byte; a string that trips this throw is surfaced as `uncheckable`, never as
 * tamper.
 */
export declare const MAX_FIELD_LEN = 8192;
export declare function normalizeString(s: string): string;
/**
 * Canonicalize (gif-audit/1): deterministic JSON with keys sorted
 * lexicographically at every level, no insignificant whitespace, strings
 * NFC-normalized + trimmed, null as the literal token `null`, booleans as
 * true/false. Byte-identical to the DB trigger's manual JSON build and to a
 * plain `sha256sum` of the same canonical string.
 */
export declare function canonicalize(v: unknown): string;
/**
 * Assemble the gif-audit/1 canonical body for a row (event_hash excluded). Maps
 * gif's stored columns to the canonical keys (persona_id → principal_id,
 * invoked_by_persona_id → invoked_by_principal_id) and pins the constant
 * `caller-governance` profile. Key insertion order is irrelevant — canonicalize
 * sorts every level.
 */
export declare function buildBody(row: AuditRow, previousHash: string | null): CanonicalBody;
/**
 * Recompute the SHA-256 event_hash for a row in its stored canonical form,
 * using the row's own stored previous_hash as the chain link (the value the
 * trigger used). Returns null for an unrecognized canon_version — a row written
 * under a newer canonical form cannot be re-verified here and must not be
 * reported as tampered (forward-safety).
 */
export declare function recomputeHash(row: AuditRow): string | null;
/**
 * Verify one month partition's worth of rows.
 *
 * Rows must be ordered by occurred_at ASC, event_id ASC — the same order the
 * trigger uses when selecting the most-recent-in-partition row for chain links.
 *
 * Per-row categories:
 *   - legacy_null:   event_hash IS NULL  → skip verification, count only
 *   - hash_error:    event_hash = 'HASH_ERROR' → write-time sentinel, skip
 *   - uncheckable:   unrecognized canon_version or normalization rejection →
 *                    cannot recompute, NOT tamper (forward-safety)
 *   - hashed:        64-char hex event_hash → recompute + linkage check
 */
export declare function verifyPartition(partitionKey: string, rows: AuditRow[]): PartitionResult;
/**
 * Verify anchor rows against live partition data.
 *
 * liveHashLookup: event_id → current event_hash
 * liveCountLookup: partition_name → current row count
 */
export declare function verifyAnchors(anchors: AnchorRow[], liveHashLookup: Map<string, string | null>, liveCountLookup: Map<string, number>): AnchorResult[];
/**
 * Pure aggregate: given already-fetched, grouped rows and optional anchor data,
 * return a structured verification result.
 *
 * partitionMap: month key (ISO string) → ordered rows
 * anchors:      null when --check-anchors was not requested
 * liveHashLookup / liveCountLookup: required when anchors is non-null
 */
export declare function verifyChain(partitionMap: Map<string, AuditRow[]>, anchors: AnchorRow[] | null, liveHashLookup?: Map<string, string | null>, liveCountLookup?: Map<string, number>): ChainVerifyResult;
//# sourceMappingURL=verify_audit_chain.d.ts.map