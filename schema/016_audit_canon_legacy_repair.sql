-- Copyright 2026 Notboatanchor Labs LLC
--
-- Licensed under the Apache License, Version 2.0 (the "License");
-- you may not use this file except in compliance with the License.
-- You may obtain a copy of the License at
--
--     http://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing, software
-- distributed under the License is distributed on an "AS IS" BASIS,
-- WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
-- See the License for the specific language governing permissions and
-- limitations under the License.

-- =============================================================================
-- GIF Schema - Migration 016
-- Repair migration-014's retroactive mis-stamp of pre-014 (migration-006) audit
-- rows as 'gif-audit/1' (issue #38).
--
-- Applies to: gif database
-- Run as: psql -U postgres -d gif -f gif/schema/016_audit_canon_legacy_repair.sql
--
-- Background:
--   Migration 014 added canon_version TEXT NOT NULL DEFAULT 'gif-audit/1'. On a
--   clean install this is correct: migrations run before any audit row exists.
--   For an adopter who recorded audit rows under v0.1 (hashed by the
--   migration-006 pipe-delimited preimage) BEFORE applying 014, the NOT NULL
--   DEFAULT retroactively stamped those historical rows 'gif-audit/1', a
--   RECOGNIZED canon they were never hashed under. The chain verifier
--   (src/cli/verify_audit_chain.ts) then recomputes them under the /1 sorted-JSON
--   rule, the digest differs from the stored pipe-form hash, and the rows are
--   reported as tamper (mismatches) instead of the correct `uncheckable` bucket.
--   This is a labeling/classification bug; the forward chain stays intact.
--
-- Fix:
--   Re-stamp to the legacy marker 'gif-audit/0' ONLY the rows we can
--   cryptographically prove were hashed under migration 006, i.e. rows
--   currently labeled 'gif-audit/1' whose stored event_hash equals the
--   migration-006 pipe-delimited preimage recomputed from the row's own stored
--   columns. The verifier does not recognize 'gif-audit/0' (recomputeHash returns
--   null for it), so those rows are classified as `uncheckable` (informational),
--   never tamper, the bucket migration 014 robbed them of.
--
--   Cryptographic identification (not a time-based or heuristic cut) is
--   deliberate and preserves tamper detection on the historical trail:
--     * An untampered 006 row matches the 006 preimage  -> re-stamped -> uncheckable.
--     * A genuinely tampered 006 row matches NEITHER 006 nor /1 -> left as
--       'gif-audit/1' -> stays a mismatch (tamper is NOT masked).
--     * A genuine post-014 'gif-audit/1' row matches the /1 preimage, not 006 ->
--       left as 'gif-audit/1' -> still verifies.
--   Idempotent: after a row is re-stamped it is 'gif-audit/0' and no longer
--   matches the WHERE, so a re-run is a no-op. A clean install matches zero rows.
--
-- Append-only note:
--   canon_version is row metadata that is NOT part of the hashed preimage (it
--   records which canonicalization produced event_hash; see migrations 014/015).
--   Correcting it changes no event_hash and no chain linkage. The UPDATE runs as
--   gif_admin (the migration role); gif_app remains INSERT-only on audit_events.
--   This is the inverse of the 015 "do not backfill canon_version" caution: 015
--   warns against RE-stamping /1 rows as /2 (which WOULD false-flag a good trail);
--   this migration UN-does 014's false stamp using cryptographic proof.
--
-- occurred_at parity:
--   The migration-006 preimage hashed occurred_at with a bare ::text cast
--   (session-timezone dependent), unlike /1 and /2 which pin UTC via to_char.
--   This migration pins the session to UTC so the recompute matches rows written
--   by a UTC-configured server (gif's default/documented deployment). A row
--   originally hashed under a since-changed non-UTC session will not match and is
--   left as-is, no worse than the pre-016 state.
-- =============================================================================

BEGIN;

-- Pin UTC for the bare occurred_at::text cast used in the migration-006 preimage.
SET LOCAL timezone = 'UTC';

-- ---------------------------------------------------------------------------
-- Re-stamp cryptographically-proven migration-006 rows: 'gif-audit/1' ->
-- 'gif-audit/0'. The match condition recomputes the migration-006 pipe-delimited
-- preimage from the row's own stored columns and compares to the stored hash.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    relabeled_count BIGINT;
BEGIN
    WITH repaired AS (
        UPDATE gif.audit_events ae
           SET canon_version = 'gif-audit/0'
         WHERE ae.canon_version = 'gif-audit/1'
           AND ae.event_hash IS NOT NULL
           AND ae.event_hash <> 'HASH_ERROR'
           AND ae.event_hash = encode(
                 sha256(convert_to(
                   concat_ws('|',
                     ae.event_id::text,
                     ae.occurred_at::text,
                     ae.persona_id::text,
                     COALESCE(ae.session_id::text, 'NULL'),
                     ae.event_type,
                     COALESCE(ae.tool_name, 'NULL'),
                     ae.outcome,
                     ae.flagged::text,
                     COALESCE(ae.previous_hash, 'NULL')
                   ), 'UTF8')), 'hex')
        RETURNING 1
    )
    SELECT count(*) INTO relabeled_count FROM repaired;

    RAISE NOTICE 'Migration 016: re-stamped % migration-006 audit row(s) gif-audit/1 -> gif-audit/0 (uncheckable, not tamper)', relabeled_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- Document the legacy marker now possible on the column (behavior unchanged).
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN gif.audit_events.canon_version IS
    'Canonical-form version under which event_hash was computed. '
    '''gif-audit/2'' = extensions-keyed-object + abstract-outcome canonical form '
    '(migration 015, current default). ''gif-audit/1'' = sorted-key JSON with '
    'single profile/profile_data (migration 014). ''gif-audit/0'' = the '
    'migration-006 pipe-delimited preimage; carried only on rows that predate '
    'migration 014 and were re-stamped from a mistaken gif-audit/1 by migration '
    '016 (issue #38). The verifier selects the rule by this column per row; it '
    'does not recognize gif-audit/0 and so reports those rows as uncheckable '
    '(informational), never tamper.';

COMMIT;
