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
// The pure verification core (canonicalization, hash recomputation, and the
// partition / anchor / chain checks) lives in src/audit/verify-core.ts; this
// file is the DB shell and report rendering around it.
//
// Sprint 5: Compliance Hardening — Deliverable 2 (chain verifier)
// =============================================================================
import pg from 'pg';
import { verifyChain, } from '../audit/verify-core.js';
const { Pool } = pg;
// ---------------------------------------------------------------------------
// DB shell — connects, fetches data, delegates to pure core
// ---------------------------------------------------------------------------
async function fetchPartitions(pool) {
    // Enumerate months that have at least one hashed row.
    const monthsResult = await pool.query(`SELECT DISTINCT date_trunc('month', occurred_at)::text AS month
     FROM gif.audit_events
     WHERE event_hash IS NOT NULL
     ORDER BY month`);
    const partitionMap = new Map();
    for (const { month } of monthsResult.rows) {
        // Fetch all rows in this partition, including NULL event_hash rows
        // (legacy pre-006 rows) so we can count them. Explicit column list; no
        // SELECT *. occurred_at is rendered with the SAME to_char(...'MS'...)
        // expression the migration-015 trigger uses, so the verifier consumes a
        // byte-identical timestamp string by construction. flagged is fetched as a
        // real boolean (the canonicalizer needs true/false, not "true"/"false").
        const rowsResult = await pool.query(`SELECT event_id::text,
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
       ORDER BY occurred_at ASC, event_id ASC`, [month]);
        partitionMap.set(month, rowsResult.rows);
    }
    return partitionMap;
}
async function fetchAnchors(pool) {
    const result = await pool.query(`SELECT anchor_id::text,
            event_id::text,
            anchor_hash,
            partition_name,
            event_count::int,
            anchored_by
     FROM gif.audit_chain_anchors
     ORDER BY anchored_at ASC`);
    return result.rows;
}
/** Build a lookup from event_id → event_hash for anchor verification. */
async function fetchLiveHashLookup(pool, eventIds) {
    if (eventIds.length === 0)
        return new Map();
    // Use unnest to avoid a large IN list
    const result = await pool.query(`SELECT event_id::text, event_hash
     FROM gif.audit_events
     WHERE event_id = ANY($1::uuid[])`, [eventIds]);
    const map = new Map();
    for (const row of result.rows) {
        map.set(row.event_id, row.event_hash);
    }
    return map;
}
/** Build a lookup from partition_name → live row count for anchor verification. */
async function fetchLiveCountLookup(pool, partitionNames) {
    if (partitionNames.length === 0)
        return new Map();
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
    const map = new Map();
    for (const name of new Set(partitionNames)) {
        // Extract YYYY_MM from the end of the partition name.
        const match = name.match(/(\d{4})_(\d{2})$/);
        if (!match) {
            map.set(name, 0);
            continue;
        }
        const year = match[1];
        const month = match[2];
        const monthStart = `${year}-${month}-01`;
        const countResult = await pool.query(`SELECT count(*)::text AS count
       FROM gif.audit_events
       WHERE occurred_at >= $1::timestamptz
         AND occurred_at <  $1::timestamptz + INTERVAL '1 month'`, [monthStart]);
        map.set(name, parseInt(countResult.rows[0].count, 10));
    }
    return map;
}
// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------
function renderHuman(result) {
    const lines = [];
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
        }
        else {
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
const jsonOutput = argv.includes('--json');
// Unknown flags — warn but don't abort (forward-compatible)
const knownFlags = new Set(['--check-anchors', '--json']);
const unknown = argv.filter(a => a.startsWith('--') && !knownFlags.has(a));
if (unknown.length > 0) {
    process.stderr.write(`Warning: unknown flag(s): ${unknown.join(', ')}\n`);
}
// Usage hint if invoked with -h or --help
if (argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write('Usage: npx ts-node src/cli/verify_audit_chain.ts [--check-anchors] [--json]\n\n' +
        '  --check-anchors   Also verify gif.audit_chain_anchors rows against live data.\n' +
        '  --json            Emit JSON result object instead of human-readable report.\n' +
        '\nConnection: PGHOST / PGPORT / PGUSER (default gif_app) / PGPASSWORD / PGDATABASE (default gif)\n');
    process.exit(0);
}
const pool = new Pool({
    host: process.env['PGHOST'] || 'localhost',
    port: parseInt(process.env['PGPORT'] || '5432'),
    user: process.env['PGUSER'] || 'gif_app',
    password: process.env['PGPASSWORD'],
    database: process.env['PGDATABASE'] || 'gif',
});
try {
    const partitionMap = await fetchPartitions(pool);
    let anchors = null;
    let liveHashLookup;
    let liveCountLookup;
    if (checkAnchors) {
        anchors = await fetchAnchors(pool);
        const eventIds = anchors.map(a => a.event_id);
        const partitionNames = anchors.map(a => a.partition_name);
        liveHashLookup = await fetchLiveHashLookup(pool, eventIds);
        liveCountLookup = await fetchLiveCountLookup(pool, partitionNames);
    }
    const result = verifyChain(partitionMap, anchors, liveHashLookup, liveCountLookup);
    if (jsonOutput) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }
    else {
        process.stdout.write(renderHuman(result));
    }
    process.exit(result.ok ? 0 : 1);
}
catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
}
finally {
    await pool.end();
}
//# sourceMappingURL=verify_audit_chain.js.map