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
-- GIF Schema — Migration 014
-- Align the audit-event integrity hash to the vendor-neutral canonical form (gif-audit/1).
--
-- Applies to: gif database
-- Run as: psql -U postgres -d gif -f gif/schema/014_audit_canonical_json.sql
--
-- Supersedes the migration-006 preimage. This changes ONLY how the integrity
-- hash is computed — storage, append-only enforcement (REVOKE/RLS), the
-- SECURITY DEFINER context, gif_admin ownership, and the partition-scoped
-- prev-hash lookup are all unchanged.
--
-- Why:
--   gif's audit record uses a vendor-neutral, tamper-evident canonical form:
--   sorted-key JSON ("gif-audit/1") that makes purpose_declared a REQUIRED,
--   chained field. Migration 006 used a pipe-delimited preimage and omitted
--   purpose_declared. This migration closes that gap: a freshly inserted row's
--   event_hash is byte-identical to the vendor-neutral reference vectors and to
--   a plain `sha256sum` of the same canonical JSON.
--
-- Canonical form (gif-audit/1):
--   preimage = canonicalize(body), body = the protected fields, keys sorted
--   lexicographically at every level, no insignificant whitespace, event_hash
--   and anchor_witness excluded.
--
--   Top-level key order:
--     event_id, event_type, occurred_at, outcome, previous_hash,
--     principal_id, profile, profile_data, tool_name
--   profile_data key order (caller-governance profile):
--     flagged, invoked_by_principal_id, purpose_declared, session_id
--
--   Column → canonical-key mapping (NO column renames; mapping is only in the
--   JSON keys): persona_id → principal_id, invoked_by_persona_id →
--   invoked_by_principal_id. profile is the constant string 'caller-governance'.
--
--   Timestamps: millisecond RFC 3339 UTC 'Z' (e.g. 2026-06-02T12:00:00.000Z).
--   String normalization: Unicode NFC + trim (btrim(normalize(x, NFC))).
--   Null vs empty: absent/null → literal JSON null (distinct from "").
--
-- Known-answer test (KAT): the canonical KAT record (see
-- mcp-server/test_chain_verifier.mjs and the vendor-neutral reference vectors)
-- hashes to
--   4ccf79a1a616c55b19cbcb5418d4c5fc31f45f793549a1b07d268b43455e6f10
--
-- Build note: the preimage is assembled by manual string concatenation, NOT
-- jsonb/jsonb_build_object. Postgres orders jsonb keys by length-then-bytes,
-- not lexicographically, so jsonb would NOT match JSON.stringify with sorted
-- keys. to_json(x)::text produces a correctly-escaped JSON literal matching
-- JSON.stringify for these values; to_json(boolean)::text → true/false.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- PART 1: Record the canonical-form version on every row.
--
-- canon_version stamps which canonicalization a row's event_hash was computed
-- under, so a future canonical-form bump can be verified per-row without
-- ambiguity. Defaulted, so existing inserts need no change; the BEFORE INSERT
-- trigger sees the default value already populated on NEW.
-- ---------------------------------------------------------------------------

ALTER TABLE gif.audit_events
    ADD COLUMN IF NOT EXISTS canon_version TEXT NOT NULL DEFAULT 'gif-audit/1';

COMMENT ON COLUMN gif.audit_events.canon_version IS
    'Canonical-form version under which event_hash was computed. '
    '''gif-audit/1'' = sorted-key JSON canonical form (migration 014). '
    'Older delimited-form rows do not exist after the migration-014 clean cut.';

-- ---------------------------------------------------------------------------
-- PART 2: Replace the hash trigger function with the gif-audit/1 preimage.
--
-- CREATE OR REPLACE updates the function body in place; the existing
-- audit_events_hash_chain trigger (migration 006) keeps pointing at it, so no
-- trigger re-creation is needed. Everything outside the preimage is preserved
-- verbatim from migration 006: SECURITY DEFINER, SET search_path, the
-- partition-scoped prev-hash lookup (ordered occurred_at DESC, event_id DESC),
-- and the never-throws HASH_ERROR + pg_notify fallback.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION gif.compute_audit_event_hash()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = gif, pg_temp
AS $$
DECLARE
    prev_hash CHAR(64);
    pd        TEXT;   -- profile_data canonical JSON (keys sorted)
    preimage  TEXT;   -- top-level canonical JSON (keys sorted)
BEGIN
    -- Step 1: Find the most recent event_hash in this month's partition.
    -- Unchanged from migration 006 (partition-scoped, newest-first).
    BEGIN
        SELECT ae.event_hash INTO prev_hash
        FROM gif.audit_events ae
        WHERE ae.occurred_at >= date_trunc('month', NEW.occurred_at)
          AND ae.occurred_at <  date_trunc('month', NEW.occurred_at) + INTERVAL '1 month'
        ORDER BY ae.occurred_at DESC, ae.event_id DESC
        LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
        prev_hash := NULL;
    END;

    -- Step 2: Build the canonical preimage (gif-audit/1).
    -- Manual string build with sorted keys; to_json(...)::text escapes string
    -- values; NULLs render as the literal JSON token `null`. String values are
    -- NFC-normalized and trimmed: btrim(normalize(x, NFC)).
    BEGIN
        -- profile_data: flagged, invoked_by_principal_id, purpose_declared, session_id
        pd := '{'
            || '"flagged":'                  || to_json(NEW.flagged)::text
            || ',"invoked_by_principal_id":' || COALESCE(to_json(NEW.invoked_by_persona_id::text)::text, 'null')
            || ',"purpose_declared":'        || COALESCE(to_json(btrim(normalize(NEW.purpose_declared, NFC)))::text, 'null')
            || ',"session_id":'              || COALESCE(to_json(NEW.session_id::text)::text, 'null')
            || '}';

        -- top level: event_id, event_type, occurred_at, outcome, previous_hash,
        --            principal_id, profile, profile_data, tool_name
        preimage := '{'
            || '"event_id":'       || to_json(NEW.event_id::text)::text
            || ',"event_type":'    || to_json(btrim(normalize(NEW.event_type, NFC)))::text
            || ',"occurred_at":'   || to_json(to_char(NEW.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text
            || ',"outcome":'       || to_json(btrim(normalize(NEW.outcome, NFC)))::text
            || ',"previous_hash":' || COALESCE(to_json(prev_hash)::text, 'null')
            || ',"principal_id":'  || to_json(NEW.persona_id::text)::text
            || ',"profile":'       || to_json('caller-governance'::text)::text
            || ',"profile_data":'  || pd
            || ',"tool_name":'     || COALESCE(to_json(btrim(normalize(NEW.tool_name, NFC)))::text, 'null')
            || '}';

        NEW.previous_hash := prev_hash;
        NEW.event_hash    := encode(sha256(convert_to(preimage, 'UTF8')), 'hex');
    EXCEPTION WHEN OTHERS THEN
        -- Never throw: a canonicalization/hash failure must not block the
        -- INSERT or mask the tool response. Flag it and alert out-of-band.
        NEW.event_hash    := 'HASH_ERROR';
        NEW.previous_hash := prev_hash;
        PERFORM pg_notify(
            'audit_chain_error',
            format('Hash computation failed for event %s: %s', NEW.event_id, SQLERRM)
        );
    END;

    RETURN NEW;
END;
$$;

-- gif_admin owns the function (table owner per ADR-032). SECURITY DEFINER runs
-- as gif_admin regardless of the calling user, so it retains full SELECT on all
-- partitions for the prev-hash lookup with no superuser dependency.
ALTER FUNCTION gif.compute_audit_event_hash() OWNER TO gif_admin;

COMMENT ON FUNCTION gif.compute_audit_event_hash() IS
    'BEFORE INSERT trigger function for gif.audit_events. '
    'Computes event_hash = sha256(canonicalize(body)) in the gif-audit/1 '
    'sorted-key JSON canonical form (migration 014). previous_hash links to the '
    'newest prior row in the same month partition. SECURITY DEFINER owned by '
    'gif_admin. Never throws — hash error written as HASH_ERROR with pg_notify alert.';

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    canon_col_exists BOOLEAN;
    trigger_exists   BOOLEAN;
    fn_owner         TEXT;
BEGIN
    -- canon_version column exists on the parent
    SELECT EXISTS(
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'gif'
          AND table_name   = 'audit_events'
          AND column_name  = 'canon_version'
    ) INTO canon_col_exists;

    IF NOT canon_col_exists THEN
        RAISE EXCEPTION 'canon_version column not found on gif.audit_events';
    END IF;

    -- The migration-006 trigger is still attached (we only replaced the function)
    SELECT EXISTS(
        SELECT 1 FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE t.tgname = 'audit_events_hash_chain'
          AND c.relname = 'audit_events'
          AND n.nspname = 'gif'
    ) INTO trigger_exists;

    IF NOT trigger_exists THEN
        RAISE EXCEPTION 'Trigger audit_events_hash_chain not found on gif.audit_events';
    END IF;

    -- Function ownership preserved (gif_admin)
    SELECT pg_get_userbyid(p.proowner) INTO fn_owner
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'gif' AND p.proname = 'compute_audit_event_hash';

    IF fn_owner IS DISTINCT FROM 'gif_admin' THEN
        RAISE EXCEPTION 'compute_audit_event_hash owner is %, expected gif_admin', fn_owner;
    END IF;

    RAISE NOTICE 'Migration 014 verified: canon_version added, trigger intact, hash fn = gif-audit/1 (owner gif_admin)';
END;
$$;

COMMIT;
