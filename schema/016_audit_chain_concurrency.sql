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
-- GIF Schema — Migration 016
-- Serialize audit hash-chain writes under concurrent INSERTs.
--
-- Applies to: gif database
-- Run as: psql -U postgres -d gif -f gif/schema/016_audit_chain_concurrency.sql
--
-- Why:
--   The prev-hash lookup in compute_audit_event_hash() is a plain SELECT under
--   READ COMMITTED (unchanged from migrations 006/014/015). Two concurrent
--   INSERTs each fail to see the other's uncommitted row, both link the same
--   parent, and the chain forks. Because previous_hash is inside the hashed
--   preimage and the table is INSERT-only, a fork can never be re-linked: every
--   collision is a permanent linkage break in chain verification. A related,
--   narrower window: occurred_at defaults to now() (transaction start), so a
--   transaction that starts first but commits second can link forward while
--   sorting earlier — an ordering inversion with the same verification effect.
--
--   This migration serializes chain writes per month partition with a
--   transaction-scoped advisory lock taken before the prev-hash read, and
--   re-stamps occurred_at under the lock so chain order and sort order agree.
--
-- What changes (three additions to the trigger function; everything else is
-- carried verbatim from migration 015):
--
--   1. SERIALIZE — pg_advisory_xact_lock(classid, objid) before the prev-hash
--      lookup. classid = 1195984449 (0x47494641, ASCII 'GIFA') namespaces
--      gif's chain locks away from adopter application advisory locks; objid =
--      linear month serial (year*12 + month-1) of the row's partition month,
--      so the lock scope is exactly the chain scope (one chain per month
--      partition). The lock releases at transaction end; no unlock path.
--
--      Blocking posture: BLOCK FOREVER, deliberately. No lock_timeout — a
--      timeout expiry would throw mid-trigger, abort the INSERT, and (because
--      audit logging never throws at the emission layer) silently drop the
--      audit row: an action without a record, the exact failure class this
--      trail exists to prevent. Lock holds are single-INSERT, millisecond
--      scale; a wedged holder (an operator transaction left open mid-INSERT)
--      is pathological and operationally visible (all audit writes stall).
--
--      The lock call sits OUTSIDE every exception handler on purpose: if
--      acquisition itself fails (query cancel, deadlock), the INSERT aborts
--      rather than proceeding unlocked — proceeding unlocked would silently
--      reopen the fork window. The emission layer treats that like any other
--      failed INSERT (caught, logged, never masks the tool response).
--
--   2. RE-STAMP — occurred_at := clock_timestamp() after lock acquisition,
--      ONLY while the clock is still inside the row's partition month.
--      Post-lock stamps are strictly ordered because the writes are
--      serialized, which closes the transaction-start inversion window. The
--      month confinement is load-bearing: partition routing has already
--      happened when a BEFORE ROW trigger runs, and a trigger that moves the
--      partition key outside the routed partition's bounds raises a partition
--      constraint violation — which would abort the INSERT and drop the row.
--      Confinement covers both a lock wait that spans a month rollover and an
--      operator INSERT explicitly stamped into another month's partition
--      (e.g. test fixtures); both keep their original stamp.
--
--   3. CHAIN-ORDER FLOOR — after the prev-hash read, if the new row's stamp
--      does not sort strictly after the tail it links to, it is bumped to
--      tail + 1 microsecond (capped at the last microsecond of the month so
--      the row stays inside its partition). This guarantees, by construction,
--      that linkage order equals (occurred_at, event_id) sort order — the
--      invariant chain verification walks — for every row written through the
--      serialized path, including the month-rollover sliver above, explicit
--      backdated stamps landing in a partition that already has later rows,
--      and a system clock stepped backwards between two writes. The audit
--      trail's posture is that occurred_at is the server's field ("timestamps
--      from server clock — not settable by application", migration 002); a
--      chained row is stamped no earlier than its predecessor.
--
--      Accepted edge: if the tail already sits at the month's last microsecond
--      (a concurrent pile-up inside the final microsecond of a month), the cap
--      makes the stamps equal and the verifier's event_id ASC tiebreak may not
--      match write order. Microsecond-bounded, once per month at most, and
--      ordering-only; accepted.
--
-- What does NOT change:
--   The canonical preimage build and canon_version stamp are byte-identical to
--   migration 015 — this migration changes when and how the occurred_at and
--   previous_hash VALUES are determined, never how the preimage is assembled
--   from them. The hash is computed after the re-stamp/floor, so stored values
--   and hashed bytes still agree. canon_version stays 'gif-audit/2'; existing
--   rows are untouched; all sealed known-answer tests remain valid. Storage,
--   append-only enforcement (REVOKE/RLS), SECURITY DEFINER, gif_admin
--   ownership, and the never-throws HASH_ERROR fallback carry over verbatim.
--
-- Operational notes:
--   * Advisory lock keys are cluster-wide, not per-database. Two gif databases
--     in one PostgreSQL cluster contend on the same (classid, month) keys —
--     false sharing that adds latency, never incorrectness. Negligible at
--     single-database deployment scale; noted for multi-database clusters.
--   * A single transaction inserting audit rows into MULTIPLE months acquires
--     one lock per month in insert order; two such transactions inserting in
--     opposite month order can deadlock (PostgreSQL detects and aborts one).
--     The emission layer writes one row per transaction and cannot hit this;
--     keep any operator multi-month backfill to one month per transaction.
--   * The prev-hash lookup's error swallow (SELECT failure → prev_hash NULL,
--     carried from 006) is unchanged and now runs under the lock. A spurious
--     swallow still genesis-links the row; pre-existing behavior, out of
--     scope here.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- PART 1: Replace the hash trigger function with the serialized build.
--
-- CREATE OR REPLACE updates the function body in place; the existing
-- audit_events_hash_chain trigger (migration 006) keeps pointing at it, so no
-- trigger re-creation is needed. The preimage build (Step 4) is preserved
-- byte-for-byte from migration 015.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION gif.compute_audit_event_hash()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = gif, pg_temp
AS $$
DECLARE
    -- Advisory-lock namespace for gif's audit chain: 0x47494641, ASCII 'GIFA'.
    -- Documented in the migration-016 header; visible in pg_locks.classid.
    k_lock_classid CONSTANT INT := 1195984449;

    prev_hash     CHAR(64);
    prev_occurred TIMESTAMPTZ;  -- tail row's stamp, for the chain-order floor
    v_month_start TIMESTAMPTZ;  -- this row's partition month (chain scope)
    v_now         TIMESTAMPTZ;
    v_lock_key    INT;
    cg            TEXT;   -- caller-governance extension body (keys sorted)
    ext           TEXT;   -- extensions keyed object (one entry: caller-governance)
    preimage      TEXT;   -- top-level canonical JSON (keys sorted)
BEGIN
    -- Step 0: stamp the canonical-form version this trigger computes under, so
    -- the row label and the hashed bytes can never disagree. (Unchanged from
    -- migration 015.)
    NEW.canon_version := 'gif-audit/2';

    -- Step 1 (new in 016): serialize this month's chain writes. The lock key
    -- is derived from the same month expression the prev-hash lookup scopes
    -- by, so lock scope ≡ chain scope ≡ routed partition. Blocks until any
    -- concurrent same-month writer commits; released at transaction end.
    -- Deliberately OUTSIDE every exception handler — see migration header.
    v_month_start := date_trunc('month', NEW.occurred_at);
    v_lock_key    := EXTRACT(YEAR FROM v_month_start)::INT * 12
                   + EXTRACT(MONTH FROM v_month_start)::INT - 1;
    PERFORM pg_advisory_xact_lock(k_lock_classid, v_lock_key);

    -- Step 2 (new in 016): re-stamp under the lock so serialized write order
    -- and occurred_at order agree. Confined to the routed partition month —
    -- a BEFORE trigger cannot move a row across partitions (see header).
    v_now := clock_timestamp();
    IF date_trunc('month', v_now) = v_month_start THEN
        NEW.occurred_at := v_now;
    END IF;

    -- Step 3: Find the most recent event_hash in this month's partition.
    -- Scope is identical to migrations 006/014/015 (partition-scoped,
    -- newest-first), expressed via v_month_start, and now also reads the tail
    -- row's occurred_at for the Step 3a floor. Serialized by the Step 1 lock,
    -- so the read is race-free.
    BEGIN
        SELECT ae.event_hash, ae.occurred_at INTO prev_hash, prev_occurred
        FROM gif.audit_events ae
        WHERE ae.occurred_at >= v_month_start
          AND ae.occurred_at <  v_month_start + INTERVAL '1 month'
        ORDER BY ae.occurred_at DESC, ae.event_id DESC
        LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
        prev_hash     := NULL;
        prev_occurred := NULL;
    END;

    -- Step 3a (new in 016): chain-order floor — a chained row is stamped no
    -- earlier than the predecessor it links to, capped at the last
    -- microsecond of the month to stay inside the routed partition.
    IF prev_occurred IS NOT NULL AND NEW.occurred_at <= prev_occurred THEN
        NEW.occurred_at := LEAST(
            prev_occurred + INTERVAL '1 microsecond',
            v_month_start + INTERVAL '1 month' - INTERVAL '1 microsecond'
        );
    END IF;

    -- Step 4: Build the canonical preimage (gif-audit/2) and hash.
    -- Byte-for-byte identical to migration 015 — do not touch without the
    -- four-site canonicalization sync (trigger, verifier core, test-harness
    -- replicas, conformance vectors) and reproduction of the sealed KATs.
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
    'Serializes chain writes per month partition via pg_advisory_xact_lock '
    '(classid 1195984449 ''GIFA'', objid = month serial; migration 016), '
    're-stamps occurred_at under the lock (confined to the routed partition '
    'month, floored strictly after the chain tail), then computes event_hash '
    '= sha256(canonicalize(body)) in the gif-audit/2 extensions-keyed-object '
    'canonical form (migration 015) and stamps canon_version = ''gif-audit/2''. '
    'previous_hash links to the newest prior row in the same month partition. '
    'SECURITY DEFINER owned by gif_admin. Never throws — hash error written as '
    'HASH_ERROR with pg_notify alert.';

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    fn_def         TEXT;
    default_expr   TEXT;
    trigger_exists BOOLEAN;
    fn_owner       TEXT;
BEGIN
    -- The serialization lock is present in the installed function body.
    SELECT pg_get_functiondef(p.oid) INTO fn_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'gif' AND p.proname = 'compute_audit_event_hash';

    IF fn_def IS NULL OR fn_def NOT LIKE '%pg_advisory_xact_lock%' THEN
        RAISE EXCEPTION 'compute_audit_event_hash does not acquire the chain advisory lock';
    END IF;

    -- This migration must NOT change canonical behavior: canon_version default
    -- is still gif-audit/2 (as set by migration 015).
    SELECT column_default INTO default_expr
    FROM information_schema.columns
    WHERE table_schema = 'gif'
      AND table_name   = 'audit_events'
      AND column_name  = 'canon_version';

    IF default_expr IS NULL OR default_expr NOT LIKE '%gif-audit/2%' THEN
        RAISE EXCEPTION 'canon_version default is %, expected gif-audit/2 (unchanged)', default_expr;
    END IF;

    -- The migration-006 trigger is still attached (we only replaced the
    -- function) AND fires BEFORE INSERT. The BEFORE-row timing is load-bearing:
    -- the function sets NEW.canon_version / NEW.event_hash / NEW.occurred_at,
    -- which an AFTER trigger could not persist. (pg_trigger.tgtype bit 1 (=2)
    -- = BEFORE.)
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

    RAISE NOTICE 'Migration 016 verified: chain writes serialized (advisory lock present), canon default = gif-audit/2 (unchanged), trigger intact, owner gif_admin';
END;
$$;

COMMIT;
