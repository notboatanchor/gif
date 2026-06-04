/** A single row as fetched from Postgres, with all fields as text strings. */
export interface AuditRow {
    event_id: string;
    occurred_at: string;
    persona_id: string;
    session_id: string | null;
    event_type: string;
    tool_name: string | null;
    outcome: string;
    flagged: string;
    event_hash: string | null;
    previous_hash: string | null;
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
    total_anchor_fails: number;
    ok: boolean;
}
/**
 * Build the SHA-256 preimage for an audit row, matching the trigger exactly.
 *
 * The trigger uses concat_ws('|', ...) with COALESCE for nullable fields, so
 * every preimage has exactly 9 pipe-delimited fields. The caller must supply
 * Postgres ::text-cast field values so timestamp format is byte-identical.
 */
export declare function buildPreimage(row: AuditRow, storedPreviousHash: string | null): string;
/**
 * Recompute the SHA-256 event_hash for a row.
 *
 * Uses the row's own stored previous_hash as the chain link value — this is
 * the value the trigger used when computing the stored event_hash.
 */
export declare function recomputeHash(row: AuditRow): string;
/**
 * Verify one month partition's worth of rows.
 *
 * Rows must be ordered by occurred_at ASC, event_id ASC — the same order the
 * trigger uses when selecting the most-recent-in-partition row for chain links.
 *
 * Per-row categories:
 *   - legacy_null:   event_hash IS NULL  → skip verification, count only
 *   - hash_error:    event_hash = 'HASH_ERROR' → write-time sentinel, skip
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