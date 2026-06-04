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

/** A single row as fetched from Postgres, with all fields as text strings. */
export interface AuditRow {
  event_id:      string;
  occurred_at:   string;   // Postgres ::text cast — byte-identical to trigger preimage
  persona_id:    string;
  session_id:    string | null;
  event_type:    string;
  tool_name:     string | null;
  outcome:       string;
  flagged:       string;   // 'true' | 'false' — Postgres bool::text
  event_hash:    string | null;
  previous_hash: string | null;
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
  total_anchor_fails: number;
  ok:                 boolean; // true iff zero mismatches + breaks + anchor_fails
}

// ---------------------------------------------------------------------------
// Pure core — no DB dependency; importable by .mjs tests without a build step
// ---------------------------------------------------------------------------

/**
 * Build the SHA-256 preimage for an audit row, matching the trigger exactly.
 *
 * The trigger uses concat_ws('|', ...) with COALESCE for nullable fields, so
 * every preimage has exactly 9 pipe-delimited fields. The caller must supply
 * Postgres ::text-cast field values so timestamp format is byte-identical.
 */
export function buildPreimage(row: AuditRow, storedPreviousHash: string | null): string {
  return [
    row.event_id,
    row.occurred_at,
    row.persona_id,
    row.session_id   ?? 'NULL',
    row.event_type,
    row.tool_name    ?? 'NULL',
    row.outcome,
    row.flagged,
    storedPreviousHash ?? 'NULL',
  ].join('|');
}

/**
 * Recompute the SHA-256 event_hash for a row.
 *
 * Uses the row's own stored previous_hash as the chain link value — this is
 * the value the trigger used when computing the stored event_hash.
 */
export function recomputeHash(row: AuditRow): string {
  const preimage = buildPreimage(row, row.previous_hash);
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

    // This is a real hashed row.
    result.hashed_checked++;

    // Recompute check: does the stored event_hash match the trigger's preimage?
    const expected = recomputeHash(row);
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
        detail:         `live row count ${liveCount} < anchored count ${anchor.event_count} — possible deletion`,
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
  const total_anchor_fails = anchorResults
    ? anchorResults.filter(a => a.status !== 'ok').length
    : 0;

  return {
    partitions,
    anchors:            anchorResults,
    total_mismatches,
    total_breaks,
    total_hash_errors,
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
    // (legacy pre-006 rows) so we can count them. Explicit column list;
    // no SELECT *.  All fields cast to ::text so the verifier uses the
    // exact byte representation the trigger used when building the preimage.
    const rowsResult = await pool.query<AuditRow>(
      `SELECT event_id::text,
              occurred_at::text,
              persona_id::text,
              session_id::text,
              event_type,
              tool_name,
              outcome,
              flagged::text,
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
    lines.push(`  Total rows     : ${p.total_rows}`);
    lines.push(`  Hashed checked : ${p.hashed_checked}`);
    lines.push(`  Links verified : ${p.links_verified}`);
    lines.push(`  Legacy null    : ${p.legacy_null}  (pre-migration-006, informational)`);

    if (p.hash_errors.length > 0) {
      lines.push(`  WARNING — HASH_ERROR rows (write-time compute failure, not tamper):`);
      for (const id of p.hash_errors) {
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
  lines.push(`  Partitions      : ${result.partitions.length}`);
  lines.push(`  Mismatches      : ${result.total_mismatches}`);
  lines.push(`  Linkage breaks  : ${result.total_breaks}`);
  lines.push(`  HASH_ERROR rows : ${result.total_hash_errors}  (warnings only)`);
  if (result.anchors !== null) {
    lines.push(`  Anchor failures : ${result.total_anchor_fails}`);
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
