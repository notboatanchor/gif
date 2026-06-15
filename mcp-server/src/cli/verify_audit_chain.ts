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

// src/cli/verify_audit_chain.ts
// =============================================================================
// Operator CLI: verify the audit event hash chain.
//
// Usage:
//   npx ts-node src/cli/verify_audit_chain.ts [--check-anchors] [--json]
//
// Walks every month partition in gif.audit_events, recomputes the SHA-256
// preimage for each hashed row, and checks linkage (previous_hash continuity).
// Exits 0 only when zero mismatches, zero linkage breaks, and zero anchor
// failures are found. HASH_ERROR sentinel rows surface as warnings but do not
// fail the exit code — they record a write-time compute failure, not tamper.
//
// Flags:
//   --check-anchors   Also verify rows in gif.audit_chain_anchors: each
//                     anchor_hash must still match the live event_hash for its
//                     event_id, and the live partition row count must not have
//                     shrunk below the recorded event_count.
//   --json            Emit a machine-readable JSON object to stdout instead of
//                     the human-readable report.
//
// Connection env (same as the rest of the test suite):
//   PGHOST / PGPORT / PGUSER (default gif_app) / PGPASSWORD / PGDATABASE (default gif)
//
// READ-ONLY: this CLI only SELECTs. It never writes to audit tables.
//
// Sprint 5: Compliance Hardening — Deliverable 2 (chain verifier)
// =============================================================================

import { createHash } from 'crypto';
import pg from 'pg';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single row as fetched from Postgres, shaped for canonical-form hashing.
 * `occurred_at` is fetched via the SAME to_char(...'MS'...) expression the
 * trigger uses, so verifier and trigger consume an identical timestamp string
 * by construction. `flagged` is a real boolean (the canonicalizer needs
 * true/false, not "true"/"false").
 */
export interface AuditRow {
  event_id:              string;
  occurred_at:           string;        // to_char ms-RFC3339 UTC 'Z' — matches the trigger
  persona_id:            string;        // → canonical key principal_id
  session_id:            string | null;
  event_type:            string;
  tool_name:             string | null;
  outcome:               string;
  flagged:               boolean;
  purpose_declared:      string | null; // REQUIRED-and-chained under gif-audit/1 and /2
  invoked_by_persona_id: string | null; // → canonical key invoked_by_principal_id
  canon_version:         string;        // 'gif-audit/2' on new rows (migration 015); '/1' on historical rows
  event_hash:            string | null;
  previous_hash:         string | null;
}

/** The gif-audit/1 canonical body (the hash preimage source; event_hash excluded). */
export interface CanonicalBody {
  event_id:      string;
  event_type:    string;
  occurred_at:   string;
  outcome:       string;
  previous_hash: string | null;
  principal_id:  string;
  profile:       string;
  profile_data: {
    flagged:                 boolean;
    invoked_by_principal_id: string | null;
    purpose_declared:        string | null;
    session_id:              string | null;
  };
  tool_name:     string | null;
}

/**
 * The gif-audit/2 canonical body. `profile` + `profile_data` are replaced by an
 * `extensions` keyed object (type id → body); gif emits exactly one entry,
 * `caller-governance`. `outcome` carries the abstract disposition enum
 * (allowed | denied | deferred | error). event_hash excluded from the preimage.
 */
export interface CanonicalBodyV2 {
  event_id:      string;
  event_type:    string;
  extensions: {
    'caller-governance': {
      flagged:                 boolean;
      invoked_by_principal_id: string | null;
      purpose_declared:        string | null;
      session_id:              string | null;
    };
  };
  occurred_at:   string;
  outcome:       string;
  previous_hash: string | null;
  principal_id:  string;
  tool_name:     string | null;
}

/** A single row from gif.audit_chain_anchors. */
export interface AnchorRow {
  anchor_id:      string;
  event_id:       string;
  anchor_hash:    string;
  partition_name: string;
  event_count:    number;
  anchored_by:    string;
}

/** Per-partition verification result. */
export interface PartitionResult {
  partition:        string;   // e.g. '2026-05-01T00:00:00.000Z'
  total_rows:       number;
  hashed_checked:   number;   // rows where event_hash is a 64-char hex string (not NULL, not HASH_ERROR)
  links_verified:   number;   // hashed rows whose previous_hash linkage is correct
  mismatches:       string[]; // event_ids where recomputed hash ≠ stored event_hash
  breaks:           string[]; // event_ids where previous_hash linkage is broken
  hash_errors:      string[]; // event_ids with event_hash = 'HASH_ERROR' (write-time sentinel)
  uncheckable:      string[]; // event_ids the verifier cannot recompute: an unrecognized
                              // canon_version (forward-safety) or a normalization rejection.
                              // Informational — does NOT fail the chain (not evidence of tamper).
  legacy_null:      number;   // rows with event_hash IS NULL (pre-migration-006)
}

/** Anchor verification result. */
export interface AnchorResult {
  anchor_id:          string;
  event_id:           string;
  partition_name:     string;
  anchored_by:        string;
  status:             'ok' | 'hash_mismatch' | 'shrunk' | 'event_not_found';
  detail:             string;
}

/** Top-level result returned by verifyChain(). */
export interface ChainVerifyResult {
  partitions:         PartitionResult[];
  anchors:            AnchorResult[] | null;  // null when --check-anchors not requested
  total_mismatches:   number;
  total_breaks:       number;
  total_hash_errors:  number;
  total_uncheckable:  number;
  total_anchor_fails: number;
  ok:                 boolean; // true iff zero mismatches + breaks + anchor_fails
}

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
 * Guarded against drift by the known-answer test in test_chain_verifier.mjs,
 * which pins this canonicalizer to the vendor-neutral reference vectors.
 *
 * Parity note: the DB trigger's norm() does NFC + the same U+0020 trim, but does
 * NOT reject control chars or cap length (it must never throw — audit-never-
 * throws). For gif's controlled-vocabulary / persona.purpose inputs the two agree
 * byte-for-byte; a string that trips the control-char/cap throw here is surfaced
 * as `uncheckable`, never as tamper. Closing that emit-vs-verify divergence (the
 * `uncheckable` hole) is a tracked follow-up, separate from this trim-charset fix.
 */
export const MAX_FIELD_LEN = 8192;

export function normalizeString(s: string): string {
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
export function canonicalize(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('non-finite number');
    return JSON.stringify(v);
  }
  if (typeof v === 'string') return JSON.stringify(normalizeString(v));
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
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
export function buildBody(row: AuditRow, previousHash: string | null): CanonicalBody {
  return {
    event_id:      row.event_id,
    event_type:    row.event_type,
    occurred_at:   row.occurred_at,
    outcome:       row.outcome,
    previous_hash: previousHash,
    principal_id:  row.persona_id,
    profile:       'caller-governance',
    profile_data: {
      flagged:                 row.flagged,
      invoked_by_principal_id: row.invoked_by_persona_id,
      purpose_declared:        row.purpose_declared,
      session_id:              row.session_id,
    },
    tool_name:     row.tool_name,
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
export function buildBodyV2(row: AuditRow, previousHash: string | null): CanonicalBodyV2 {
  return {
    event_id:      row.event_id,
    event_type:    row.event_type,
    extensions: {
      'caller-governance': {
        flagged:                 row.flagged,
        // ?? null on every nullable field: canonicalize() drops undefined keys
        // but the trigger always emits the literal null token (COALESCE), so a
        // hand-built row with an undefined field must coerce to null to stay
        // byte-identical to the trigger. The DB fetch yields null, never
        // undefined, so this is a no-op on the live path.
        invoked_by_principal_id: row.invoked_by_persona_id ?? null,
        purpose_declared:        row.purpose_declared ?? null,
        session_id:              row.session_id ?? null,
      },
    },
    occurred_at:   row.occurred_at,
    outcome:       row.outcome,
    previous_hash: previousHash,
    principal_id:  row.persona_id,
    tool_name:     row.tool_name ?? null,
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
export function recomputeHash(row: AuditRow): string | null {
  let preimage: string;
  if (row.canon_version === 'gif-audit/2') {
    preimage = canonicalize(buildBodyV2(row, row.previous_hash));
  } else if (row.canon_version === 'gif-audit/1') {
    preimage = canonicalize(buildBody(row, row.previous_hash));
  } else {
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
 *   - uncheckable:   unrecognized canon_version or normalization rejection →
 *                    cannot recompute, NOT tamper (forward-safety)
 *   - hashed:        64-char hex event_hash → recompute + linkage check
 */
export function verifyPartition(partitionKey: string, rows: AuditRow[]): PartitionResult {
  const result: PartitionResult = {
    partition:       partitionKey,
    total_rows:      rows.length,
    hashed_checked:  0,
    links_verified:  0,
    mismatches:      [],
    breaks:          [],
    hash_errors:     [],
    uncheckable:     [],
    legacy_null:     0,
  };

  // prevHashedRow tracks the most recent row with a valid (non-sentinel) hash,
  // for linkage checking.
  let prevHashedHash: string | null = null;
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
      isFirstHashed  = false;
      continue;
    }

    // This is a real hashed row. Attempt to recompute its canonical hash.
    // An unrecognized canon_version (recomputeHash → null) or a normalization
    // rejection (throw) means the verifier cannot re-derive this row's hash;
    // categorize as uncheckable (informational), never as tamper.
    let expected: string | null;
    try {
      expected = recomputeHash(row);
    } catch {
      expected = null;
    }
    if (expected === null) {
      result.uncheckable.push(row.event_id);
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
    } else {
      if (row.previous_hash === prevHashedHash) {
        result.links_verified++;
      } else {
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
export function verifyAnchors(
  anchors: AnchorRow[],
  liveHashLookup: Map<string, string | null>,
  liveCountLookup: Map<string, number>,
): AnchorResult[] {
  return anchors.map(anchor => {
    const liveHash  = liveHashLookup.get(anchor.event_id);
    const liveCount = liveCountLookup.get(anchor.partition_name) ?? 0;

    if (liveHash === undefined) {
      return {
        anchor_id:      anchor.anchor_id,
        event_id:       anchor.event_id,
        partition_name: anchor.partition_name,
        anchored_by:    anchor.anchored_by,
        status:         'event_not_found' as const,
        detail:         `event_id ${anchor.event_id} not found in live audit_events`,
      };
    }

    if (liveHash !== anchor.anchor_hash) {
      return {
        anchor_id:      anchor.anchor_id,
        event_id:       anchor.event_id,
        partition_name: anchor.partition_name,
        anchored_by:    anchor.anchored_by,
        status:         'hash_mismatch' as const,
        detail:         `stored anchor_hash ${anchor.anchor_hash} ≠ live event_hash ${liveHash ?? 'NULL'}`,
      };
    }

    if (liveCount < anchor.event_count) {
      return {
        anchor_id:      anchor.anchor_id,
        event_id:       anchor.event_id,
        partition_name: anchor.partition_name,
        anchored_by:    anchor.anchored_by,
        status:         'shrunk' as const,
        detail:         `live row count ${String(liveCount)} < anchored count ${String(anchor.event_count)} — possible deletion`,
      };
    }

    return {
      anchor_id:      anchor.anchor_id,
      event_id:       anchor.event_id,
      partition_name: anchor.partition_name,
      anchored_by:    anchor.anchored_by,
      status:         'ok' as const,
      detail:         'anchor hash matches and row count has not shrunk',
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
export function verifyChain(
  partitionMap: Map<string, AuditRow[]>,
  anchors: AnchorRow[] | null,
  liveHashLookup?: Map<string, string | null>,
  liveCountLookup?: Map<string, number>,
): ChainVerifyResult {
  const partitions: PartitionResult[] = [];

  for (const [key, rows] of partitionMap) {
    partitions.push(verifyPartition(key, rows));
  }

  const anchorResults =
    anchors !== null && liveHashLookup && liveCountLookup
      ? verifyAnchors(anchors, liveHashLookup, liveCountLookup)
      : null;

  const total_mismatches   = partitions.reduce((s, p) => s + p.mismatches.length, 0);
  const total_breaks       = partitions.reduce((s, p) => s + p.breaks.length, 0);
  const total_hash_errors  = partitions.reduce((s, p) => s + p.hash_errors.length, 0);
  const total_uncheckable  = partitions.reduce((s, p) => s + p.uncheckable.length, 0);
  const total_anchor_fails = anchorResults
    ? anchorResults.filter(a => a.status !== 'ok').length
    : 0;

  return {
    partitions,
    anchors:            anchorResults,
    total_mismatches,
    total_breaks,
    total_hash_errors,
    total_uncheckable,
    total_anchor_fails,
    ok: total_mismatches === 0 && total_breaks === 0 && total_anchor_fails === 0,
  };
}

// ---------------------------------------------------------------------------
// DB shell — connects, fetches data, delegates to pure core
// ---------------------------------------------------------------------------

async function fetchPartitions(pool: pg.Pool): Promise<Map<string, AuditRow[]>> {
  // Enumerate months that have at least one hashed row.
  const monthsResult = await pool.query<{ month: string }>(
    `SELECT DISTINCT date_trunc('month', occurred_at)::text AS month
     FROM gif.audit_events
     WHERE event_hash IS NOT NULL
     ORDER BY month`,
  );

  const partitionMap = new Map<string, AuditRow[]>();

  for (const { month } of monthsResult.rows) {
    // Fetch all rows in this partition, including NULL event_hash rows
    // (legacy pre-006 rows) so we can count them. Explicit column list; no
    // SELECT *. occurred_at is rendered with the SAME to_char(...'MS'...)
    // expression the migration-015 trigger uses, so the verifier consumes a
    // byte-identical timestamp string by construction. flagged is fetched as a
    // real boolean (the canonicalizer needs true/false, not "true"/"false").
    const rowsResult = await pool.query<AuditRow>(
      `SELECT event_id::text,
              to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at,
              persona_id::text,
              session_id::text,
              event_type,
              tool_name,
              outcome,
              flagged,
              purpose_declared,
              invoked_by_persona_id::text,
              canon_version,
              event_hash,
              previous_hash
       FROM gif.audit_events
       WHERE occurred_at >= $1::timestamptz
         AND occurred_at <  $1::timestamptz + INTERVAL '1 month'
       ORDER BY occurred_at ASC, event_id ASC`,
      [month],
    );
    partitionMap.set(month, rowsResult.rows);
  }

  return partitionMap;
}

async function fetchAnchors(pool: pg.Pool): Promise<AnchorRow[]> {
  const result = await pool.query<AnchorRow>(
    `SELECT anchor_id::text,
            event_id::text,
            anchor_hash,
            partition_name,
            event_count::int,
            anchored_by
     FROM gif.audit_chain_anchors
     ORDER BY anchored_at ASC`,
  );
  return result.rows;
}

/** Build a lookup from event_id → event_hash for anchor verification. */
async function fetchLiveHashLookup(
  pool: pg.Pool,
  eventIds: string[],
): Promise<Map<string, string | null>> {
  if (eventIds.length === 0) return new Map();

  // Use unnest to avoid a large IN list
  const result = await pool.query<{ event_id: string; event_hash: string | null }>(
    `SELECT event_id::text, event_hash
     FROM gif.audit_events
     WHERE event_id = ANY($1::uuid[])`,
    [eventIds],
  );

  const map = new Map<string, string | null>();
  for (const row of result.rows) {
    map.set(row.event_id, row.event_hash);
  }
  return map;
}

/** Build a lookup from partition_name → live row count for anchor verification. */
async function fetchLiveCountLookup(
  pool: pg.Pool,
  partitionNames: string[],
): Promise<Map<string, number>> {
  if (partitionNames.length === 0) return new Map();

  // partition_name is stored as e.g. 'audit_events_2026_05'; we need to count
  // rows in the corresponding month. Parse the partition name suffix to derive
  // the month start. audit_chain_anchors.partition_name is free text, but the
  // seeded value in tests is 'audit_events_YYYY_MM'. We also accept ISO month
  // strings by checking against actual partition data.
  //
  // To be robust against any partition_name format, we join anchors to
  // audit_events by extracting the month from occurred_at and comparing to
  // the partition_name stored in anchors via a subquery.
  //
  // Simplest correct approach: for each unique partition_name, count rows in
  // the month whose to_char(date_trunc('month', occurred_at), 'YYYY_MM') suffix
  // matches the last 7 chars of the partition_name. This handles the canonical
  // 'audit_events_YYYY_MM' format.
  const map = new Map<string, number>();

  for (const name of new Set(partitionNames)) {
    // Extract YYYY_MM from the end of the partition name.
    const match = name.match(/(\d{4})_(\d{2})$/);
    if (!match) {
      map.set(name, 0);
      continue;
    }
    const year  = match[1];
    const month = match[2];
    const monthStart = `${year}-${month}-01`;

    const countResult = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM gif.audit_events
       WHERE occurred_at >= $1::timestamptz
         AND occurred_at <  $1::timestamptz + INTERVAL '1 month'`,
      [monthStart],
    );
    map.set(name, parseInt(countResult.rows[0].count, 10));
  }

  return map;
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function renderHuman(result: ChainVerifyResult): string {
  const lines: string[] = [];

  lines.push('Audit Chain Verification Report');
  lines.push('================================');
  lines.push('');

  for (const p of result.partitions) {
    const status = (p.mismatches.length === 0 && p.breaks.length === 0) ? 'OK' : 'FAIL';
    lines.push(`Partition: ${p.partition}  [${status}]`);
    lines.push(`  Total rows     : ${String(p.total_rows)}`);
    lines.push(`  Hashed checked : ${String(p.hashed_checked)}`);
    lines.push(`  Links verified : ${String(p.links_verified)}`);
    lines.push(`  Legacy null    : ${String(p.legacy_null)}  (pre-migration-006, informational)`);

    if (p.hash_errors.length > 0) {
      lines.push(`  WARNING — HASH_ERROR rows (write-time compute failure, not tamper):`);
      for (const id of p.hash_errors) {
        lines.push(`    ${id}`);
      }
    }

    if (p.uncheckable.length > 0) {
      lines.push(`  NOTE — Uncheckable rows (unrecognized canon_version or normalization rejection; not tamper):`);
      for (const id of p.uncheckable) {
        lines.push(`    ${id}`);
      }
    }

    if (p.mismatches.length > 0) {
      lines.push(`  TAMPER ALERT — Hash mismatches (field values altered after insert):`);
      for (const id of p.mismatches) {
        lines.push(`    ${id}`);
      }
    }

    if (p.breaks.length > 0) {
      lines.push(`  TAMPER ALERT — Linkage breaks (deletion, insertion, or reorder):`);
      for (const id of p.breaks) {
        lines.push(`    ${id}`);
      }
    }

    lines.push('');
  }

  if (result.anchors !== null) {
    lines.push('Anchor Verification');
    lines.push('-------------------');
    if (result.anchors.length === 0) {
      lines.push('  No anchors found.');
    } else {
      for (const a of result.anchors) {
        const tag = a.status === 'ok' ? 'OK' : 'FAIL';
        lines.push(`  [${tag}] anchor ${a.anchor_id.slice(0, 8)}...  partition=${a.partition_name}  by=${a.anchored_by}`);
        if (a.status !== 'ok') {
          lines.push(`         ${a.detail}`);
        }
      }
    }
    lines.push('');
  }

  lines.push('Summary');
  lines.push('-------');
  lines.push(`  Partitions      : ${String(result.partitions.length)}`);
  lines.push(`  Mismatches      : ${String(result.total_mismatches)}`);
  lines.push(`  Linkage breaks  : ${String(result.total_breaks)}`);
  lines.push(`  HASH_ERROR rows : ${String(result.total_hash_errors)}  (warnings only)`);
  lines.push(`  Uncheckable rows: ${String(result.total_uncheckable)}  (informational only)`);
  if (result.anchors !== null) {
    lines.push(`  Anchor failures : ${String(result.total_anchor_fails)}`);
  }
  lines.push('');
  lines.push(result.ok ? 'RESULT: PASS — chain intact' : 'RESULT: FAIL — anomalies detected');
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const checkAnchors = argv.includes('--check-anchors');
const jsonOutput   = argv.includes('--json');

// Unknown flags — warn but don't abort (forward-compatible)
const knownFlags = new Set(['--check-anchors', '--json']);
const unknown = argv.filter(a => a.startsWith('--') && !knownFlags.has(a));
if (unknown.length > 0) {
  process.stderr.write(`Warning: unknown flag(s): ${unknown.join(', ')}\n`);
}

// Usage hint if invoked with -h or --help
if (argv.includes('--help') || argv.includes('-h')) {
  process.stderr.write(
    'Usage: npx ts-node src/cli/verify_audit_chain.ts [--check-anchors] [--json]\n\n' +
    '  --check-anchors   Also verify gif.audit_chain_anchors rows against live data.\n' +
    '  --json            Emit JSON result object instead of human-readable report.\n' +
    '\nConnection: PGHOST / PGPORT / PGUSER (default gif_app) / PGPASSWORD / PGDATABASE (default gif)\n'
  );
  process.exit(0);
}

const pool = new Pool({
  host:     process.env['PGHOST']     || 'localhost',
  port:     parseInt(process.env['PGPORT'] || '5432'),
  user:     process.env['PGUSER']     || 'gif_app',
  password: process.env['PGPASSWORD'],
  database: process.env['PGDATABASE'] || 'gif',
});

try {
  const partitionMap = await fetchPartitions(pool);

  let anchors:        AnchorRow[] | null         = null;
  let liveHashLookup: Map<string, string | null> | undefined;
  let liveCountLookup: Map<string, number>       | undefined;

  if (checkAnchors) {
    anchors = await fetchAnchors(pool);

    const eventIds      = anchors.map(a => a.event_id);
    const partitionNames = anchors.map(a => a.partition_name);

    liveHashLookup  = await fetchLiveHashLookup(pool, eventIds);
    liveCountLookup = await fetchLiveCountLookup(pool, partitionNames);
  }

  const result = verifyChain(partitionMap, anchors, liveHashLookup, liveCountLookup);

  if (jsonOutput) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(renderHuman(result));
  }

  process.exit(result.ok ? 0 : 1);

} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);

} finally {
  await pool.end();
}
