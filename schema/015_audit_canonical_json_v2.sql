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
-- GIF Schema — Migration 015
-- Re-cut the audit-event integrity hash to the gif-audit/2 canonical form.
--
-- Applies to: gif database
-- Run as: psql -U postgres -d gif -f gif/schema/015_audit_canonical_json_v2.sql
--
-- Supersedes the migration-014 (gif-audit/1) preimage. Like 014, this changes
-- ONLY how the integrity hash is computed and which canon_version new rows are
-- stamped with — storage, append-only enforcement (REVOKE/RLS), the
-- SECURITY DEFINER context, gif_admin ownership, and the partition-scoped
-- prev-hash lookup are all unchanged and carried over verbatim from 014.
--
-- Why (the gif-audit/2 standard-shape re-cut):
--   The vendor-neutral, tamper-evident audit-record canonical form moves to a
--   multi-vendor shape that changes the hash preimage in two ways from /1:
--     1. `extensions` KEYED OBJECT replaces the single `profile` +
--        `profile_data`. The preimage carries
--        extensions:{"<type>":<body>, ...} — one entry per registered type id,
--        type id as a preimage KEY, keys sorted by the same every-level
--        key-sort. gif authors exactly one extension (`caller-governance`), so
--        a gif row is a one-entry object. The keyed-object form is the
--        mandated cross-vendor preimage representation (not an array, not
--        implementation-chosen) so two vendors hash a multi-extension record
--        byte-identically.
--     2. `outcome` carries the closed ABSTRACT disposition enum
--        (allowed | denied | deferred | error). Domain reason codes live in
--        the extension / event_type, not in `outcome`. The abstract value is
--        written at the emission layer (gif-enforcement), so the trigger uses
--        NEW.outcome as-is — stored value == hashed value, no mapping here.
--   Both moves change the preimage ⇒ a new known-answer test and a
--   canon_version bump to gif-audit/2.
--
-- Carried UNCHANGED from gif-audit/1 (do not re-derive — these are locked):
--   sorted keys at every level, compact JSON (no insignificant whitespace),
--   literal JSON `null` distinct from "", RFC 3339 millisecond UTC 'Z'
--   timestamps, SHA-256, event_hash + anchor_witness excluded from the
--   preimage, canon_version recorded on the row (NOT in the hashed bytes),
--   string normalization btrim(normalize(x, NFC)).
--
-- Canonical form (gif-audit/2):
--   Top-level key order (sorted):
--     event_id, event_type, extensions, occurred_at, outcome,
--     previous_hash, principal_id, tool_name
--   extensions (one entry):
--     {"caller-governance": <caller-governance body>}
--   caller-governance body key order (sorted):
--     flagged, invoked_by_principal_id, purpose_declared, session_id
--
--   Column → canonical-key mapping (NO column renames; mapping is only in the
--   JSON keys): persona_id → principal_id, invoked_by_persona_id →
--   invoked_by_principal_id. The extension type id is the constant string
--   'caller-governance'.
--
-- Known-answer test (KAT): gif's trigger emits the one-entry caller-governance
-- record. Its gif-audit/2 canonical preimage hashes to
--   d494769c1ae442ea88dd190068747abf63c0568a3b856f85791b1a50a99d48b4
-- reproducible by a stock `printf '<preimage>' | sha256sum` and pinned in
-- mcp-server/test_chain_verifier.mjs. The multi-extension hashing rule (two
-- registered type ids hashing side by side under one digest) is pinned with the
-- vendor-neutral reference vectors and exercised synthetically in the same test;
-- it is not reproduced here because gif emits a single extension.
--
-- Build note: the preimage is assembled by manual string concatenation, NOT
-- jsonb/jsonb_build_object (Postgres orders jsonb keys by length-then-bytes,
-- not lexicographically). to_json(x)::text produces a correctly-escaped JSON
-- literal matching JSON.stringify for these values; to_json(boolean)::text →
-- true/false. This trigger build must stay byte-identical to buildBodyV2() +
-- canonicalize() in src/cli/verify_audit_chain.ts.
--
-- gif-audit/1 rows are NOT rewritten. Existing rows keep canon_version
-- 'gif-audit/1' and their /1 event_hash; the verifier recomputes each row
-- under its own stamped canon_version (forward/backward-compatible). Do NOT
-- backfill canon_version onto historical rows — that would re-stamp /1 rows as
-- /2 and false-flag the entire prior trail as tampered.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- PART 1: New rows are stamped gif-audit/2.
--
-- ALTER ... SET DEFAULT changes the default for NEW inserts only; existing
-- rows are untouched and keep their stored 'gif-audit/1' value. The trigger
-- below ALSO forces NEW.canon_version := 'gif-audit/2' so the version label
-- can never disagree with the canonicalization the trigger actually performed
-- (e.g. an explicit insert that tried to set a different value).
-- ---------------------------------------------------------------------------

ALTER TABLE gif.audit_events
    ALTER COLUMN canon_version SET DEFAULT 'gif-audit/2';

COMMENT ON COLUMN gif.audit_events.canon_version IS
    'Canonical-form version under which event_hash was computed. '
    '''gif-audit/2'' = extensions-keyed-object + abstract-outcome canonical form '
    '(migration 015). ''gif-audit/1'' = sorted-key JSON with single '
    'profile/profile_data (migration 014); historical rows retain it and verify '
    'under the /1 rule. The verifier selects the rule by this column per row.';

COMMENT ON COLUMN gif.audit_events.outcome IS
    'Abstract disposition of the governed action under gif-audit/2: '
    'allowed | denied | deferred | error. Closed enum written by the '
    'enforcement layer; domain reason codes live in event_type / the extension, '
    'not here. Enforced at emission (no DB CHECK — a constrained INSERT must '
    'never block an audit write).';

-- ---------------------------------------------------------------------------
-- PART 2: Replace the hash trigger function with the gif-audit/2 preimage.
--
-- CREATE OR REPLACE updates the function body in place; the existing
-- audit_events_hash_chain trigger (migration 006) keeps pointing at it, so no
-- trigger re-creation is needed. Everything outside the preimage + the
-- canon_version stamp is preserved verbatim from migration 014: SECURITY
-- DEFINER, SET search_path, the partition-scoped prev-hash lookup (ordered
-- occurred_at DESC, event_id DESC), and the never-throws HASH_ERROR +
-- pg_notify fallback.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION gif.compute_audit_event_hash()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = gif, pg_temp
AS $$
DECLARE
    prev_hash CHAR(64);
    cg        TEXT;   -- caller-governance extension body (keys sorted)
    ext       TEXT;   -- extensions keyed object (one entry: caller-governance)
    preimage  TEXT;   -- top-level canonical JSON (keys sorted)
BEGIN
    -- Step 0: stamp the canonical-form version this trigger computes under, so
    -- the row label and the hashed bytes can never disagree.
    NEW.canon_version := 'gif-audit/2';

    -- Step 1: Find the most recent event_hash in this month's partition.
    -- Unchanged from migration 006/014 (partition-scoped, newest-first).
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

    -- Step 2: Build the canonical preimage (gif-audit/2).
    -- Manual string build with sorted keys; to_json(...)::text escapes string
    -- values; NULLs render as the literal JSON token `null`. String values are
    -- NFC-normalized and trimmed: btrim(normalize(x, NFC)).
    BEGIN
        -- caller-governance body: flagged, invoked_by_principal_id,
        -- purpose_declared, session_id
        cg := '{'
            || '"flagged":'                  || to_json(NEW.flagged)::text
            || ',"invoked_by_principal_id":' || COALESCE(to_json(NEW.invoked_by_persona_id::text)::text, 'null')
            || ',"purpose_declared":'        || COALESCE(to_json(btrim(normalize(NEW.purpose_declared, NFC)))::text, 'null')
            || ',"session_id":'              || COALESCE(to_json(NEW.session_id::text)::text, 'null')
            || '}';

        -- extensions keyed object: one entry, type id 'caller-governance' as
        -- the (constant) preimage key. No escaping needed for this literal key.
        ext := '{"caller-governance":' || cg || '}';

        -- top level: event_id, event_type, extensions, occurred_at, outcome,
        --            previous_hash, principal_id, tool_name
        preimage := '{'
            || '"event_id":'       || to_json(NEW.event_id::text)::text
            || ',"event_type":'    || to_json(btrim(normalize(NEW.event_type, NFC)))::text
            || ',"extensions":'    || ext
            || ',"occurred_at":'   || to_json(to_char(NEW.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text
            || ',"outcome":'       || to_json(btrim(normalize(NEW.outcome, NFC)))::text
            || ',"previous_hash":' || COALESCE(to_json(prev_hash)::text, 'null')
            || ',"principal_id":'  || to_json(NEW.persona_id::text)::text
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
    'Computes event_hash = sha256(canonicalize(body)) in the gif-audit/2 '
    'extensions-keyed-object canonical form (migration 015) and stamps '
    'canon_version = ''gif-audit/2''. previous_hash links to the newest prior '
    'row in the same month partition. SECURITY DEFINER owned by gif_admin. '
    'Never throws — hash error written as HASH_ERROR with pg_notify alert.';

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    default_expr   TEXT;
    trigger_exists BOOLEAN;
    fn_owner       TEXT;
BEGIN
    -- canon_version default is now gif-audit/2 (new rows only; historical rows
    -- keep their stored value).
    SELECT column_default INTO default_expr
    FROM information_schema.columns
    WHERE table_schema = 'gif'
      AND table_name   = 'audit_events'
      AND column_name  = 'canon_version';

    IF default_expr IS NULL OR default_expr NOT LIKE '%gif-audit/2%' THEN
        RAISE EXCEPTION 'canon_version default is %, expected gif-audit/2', default_expr;
    END IF;

    -- The migration-006 trigger is still attached (we only replaced the
    -- function) AND fires BEFORE INSERT. The BEFORE-row timing is load-bearing:
    -- the function sets NEW.canon_version / NEW.event_hash, which an AFTER
    -- trigger could not persist. (pg_trigger.tgtype bit 1 (=2) = BEFORE.)
    SELECT EXISTS(
        SELECT 1 FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE t.tgname = 'audit_events_hash_chain'
          AND c.relname = 'audit_events'
          AND n.nspname = 'gif'
          AND (t.tgtype & 2) = 2   -- BEFORE
          AND (t.tgtype & 1) = 1   -- ROW
    ) INTO trigger_exists;

    IF NOT trigger_exists THEN
        RAISE EXCEPTION 'Trigger audit_events_hash_chain not found as a BEFORE ROW trigger on gif.audit_events';
    END IF;

    -- Function ownership preserved (gif_admin)
    SELECT pg_get_userbyid(p.proowner) INTO fn_owner
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'gif' AND p.proname = 'compute_audit_event_hash';

    IF fn_owner IS DISTINCT FROM 'gif_admin' THEN
        RAISE EXCEPTION 'compute_audit_event_hash owner is %, expected gif_admin', fn_owner;
    END IF;

    RAISE NOTICE 'Migration 015 verified: canon_version default = gif-audit/2, trigger intact, hash fn = gif-audit/2 (owner gif_admin)';
END;
$$;

COMMIT;
