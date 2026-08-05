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
--   This migration serializes chain writes per month partition by locking a
--   row in a gif-owned lock table before the prev-hash read, and re-stamps
--   occurred_at under the lock so chain order and sort order agree.
--
-- What changes (three additions to the trigger function; everything else is
-- carried verbatim from migration 015):
--
--   1. SERIALIZE — the trigger takes SELECT ... FOR UPDATE on this month's
--      row in gif.audit_chain_locks (created below; one row per month,
--      self-created on first use) before the prev-hash lookup. The row lock
--      releases at transaction end; lock scope is exactly the chain scope
--      (one chain per month partition).
--
--      Why a lock table and not pg_advisory_xact_lock: advisory-lock
--      functions are executable by PUBLIC and their keyspace is open — any
--      role with CONNECT on this database, holding no grant on any gif
--      object, could acquire the (documented) chain key and wedge all audit
--      writes indefinitely. A gif-owned lock row is privilege-scoped by the
--      grant model: this table carries NO grants, so the only code path that
--      can ever contend for the lock is this SECURITY DEFINER trigger.
--      Structural, not policy — consistent with the append-only enforcement.
--
--      Blocking posture: BLOCK FOREVER, deliberately. No lock_timeout — a
--      timeout expiry would throw mid-trigger, abort the INSERT, and (because
--      audit logging never throws at the emission layer) silently drop the
--      audit row: an action without a record, the exact failure class this
--      trail exists to prevent. Lock holds are single-INSERT, millisecond
--      scale; a wedged holder (a transaction left open mid-INSERT) is
--      pathological and operationally visible (all audit writes stall; the
--      waiters appear in pg_stat_activity with wait_event_type = 'Lock').
--
--      The lock acquisition sits OUTSIDE every exception handler on purpose:
--      if it fails (query cancel, deadlock), the INSERT aborts rather than
--      proceeding unlocked — proceeding unlocked would silently reopen the
--      fork window. The emission layer treats that like any other failed
--      INSERT (caught, logged, never masks the tool response).
--
--   2. RE-STAMP — occurred_at := clock_timestamp() after lock acquisition,
--      ONLY while the clock is still inside the row's partition month.
--      Post-lock stamps are strictly ordered because the writes are
--      serialized, which closes the transaction-start inversion window. The
--      month confinement is load-bearing: partition routing has already
--      happened when a BEFORE ROW trigger runs, and a trigger that moves the
--      partition key into another partition's range makes PostgreSQL abort
--      the INSERT (error 0A000, "moving row to another partition during a
--      BEFORE FOR EACH ROW trigger is not supported") — which would drop the
--      row. Confinement covers both a lock wait that spans a month rollover
--      and an INSERT explicitly stamped into another month's partition
--      (e.g. test fixtures); both keep their original stamp.
--
--      Note the resulting asymmetry, which is deliberate: an explicitly
--      supplied occurred_at in the CURRENT month is overwritten with the
--      server clock (the trail's posture since migration 002 — "timestamps
--      from server clock — not settable by application"); an explicit stamp
--      in another month's partition is preserved, subject to the floor below.
--
--   3. CHAIN-ORDER FLOOR — after the prev-hash read, if the new row's stamp
--      does not sort strictly after the tail it links to, it is bumped to
--      tail + 1 microsecond (capped at the last microsecond of the month so
--      the row stays inside its partition). This guarantees, by construction,
--      that linkage order equals (occurred_at, event_id) sort order — the
--      invariant chain verification walks — for every row written through the
--      serialized path, including the month-rollover sliver above, explicit
--      backdated stamps landing in a partition that already has later rows,
--      and a system clock stepped backwards between two writes.
--
--      Accepted consequences, explicitly:
--      * If the tail already sits at the month's last microsecond (a
--        concurrent pile-up inside the final microsecond of a month), the cap
--        makes the stamps equal and the verifier's event_id ASC tiebreak may
--        not match write order. Microsecond-bounded, ordering-only; accepted.
--      * The floor makes rows AFTER an out-of-order tail self-consistent by
--        adjusting their stamps forward. A future-forged tail (which requires
--        direct SQL with INSERT privilege — the application path never sends
--        occurred_at) would therefore silently drag subsequent stamps forward
--        instead of leaving a visible inversion. To keep that visible, any
--        floor bump larger than 1 second emits a pg_notify on channel
--        'audit_chain_order_alert' (best-effort — the emission can never
--        abort the write). Benign concurrency bumps are microsecond-scale
--        and stay silent.
--
-- Cutover: this migration takes LOCK TABLE gif.audit_events IN ACCESS
-- EXCLUSIVE MODE first. CREATE OR REPLACE FUNCTION does not wait for
-- in-flight calls of the old function body, so without the barrier an
-- old-body writer (lock-free) could overlap a new-body writer and fork the
-- chain during the apply itself. The table lock drains in-flight writers,
-- holds new arrivals until commit, and makes the cutover atomic.
--
-- Timezone invariant: all month derivations in the trigger run under the
-- function-pinned TimeZone = 'UTC' (SET clause below), so every session
-- derives identical chain scopes, lock keys, and floor caps regardless of
-- its own TimeZone setting. This is only safe when the audit_events
-- partition bounds themselves are UTC month-aligned — bounds are absolute
-- instants frozen at partition creation. The verify block asserts that
-- alignment for every existing partition and REFUSES the migration
-- otherwise (fail loudly at apply time, not silently at insert time).
-- Partitions created after this migration must also be UTC month-aligned:
-- create them with explicit '+00' bounds or under a UTC session. Both
-- partition-provisioning procedures pin this
-- (docs/runbooks/adopter/production-deployment.md sets TIME ZONE 'UTC';
-- docs/ops-runbook-audit-retention.md uses explicit '+00' bounds).
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
--   * A single transaction inserting audit rows into MULTIPLE months acquires
--     one lock row per month in insert order; two such transactions inserting
--     in opposite month order can deadlock (PostgreSQL detects and aborts
--     one — and the aborted transaction's pending audit rows are lost, an
--     accepted action-without-a-record exception confined to manual
--     multi-month backfills). The emission layer writes one row per
--     transaction and cannot hit this; keep any operator multi-month backfill
--     to one month per transaction.
--   * The prev-hash lookup's error swallow (SELECT failure → prev_hash NULL,
--     carried from 006) is unchanged and now runs under the lock. A spurious
--     swallow genesis-links the row AND skips the chain-order floor (the tail
--     stamp is unknown); pre-existing behavior, out of scope here.
--   * gif.audit_chain_locks accumulates one row per month ever written.
--     Rows are never deleted; rows for retired partitions are harmless.
--
-- Rollback: re-run migration 015's "PART 2" (its CREATE OR REPLACE FUNCTION
-- statement, verbatim) to restore the pre-016 trigger body, then optionally
-- DROP TABLE gif.audit_chain_locks. Rolling back reopens the concurrency
-- fork window this migration closes.
-- =============================================================================

BEGIN;

-- Drain in-flight audit writers and hold new ones until this transaction
-- commits — see "Cutover" in the header. Cascades to all partitions.
-- lock_timeout bounds the wait: on a busy cluster the ACCESS EXCLUSIVE
-- request would otherwise queue behind any long-running reader while
-- blocking all audit writes queued behind it. On timeout the whole
-- migration aborts cleanly (single transaction, no partial state) and can
-- be retried in a quieter window. In-flight audit writes are ms-scale, so
-- 60s only trips when something long-running holds the table.
SET LOCAL lock_timeout = '60s';
LOCK TABLE gif.audit_events IN ACCESS EXCLUSIVE MODE;

-- ---------------------------------------------------------------------------
-- PART 1: The chain lock table.
--
-- One row per month partition; the trigger locks the row FOR UPDATE to
-- serialize that month's chain writes, creating the row on first use.
-- Deliberately NO grants to anyone: the SECURITY DEFINER trigger (owned by
-- gif_admin) is the only code path that touches it. Do not grant.
-- ---------------------------------------------------------------------------

CREATE TABLE gif.audit_chain_locks (
    month_start TIMESTAMPTZ PRIMARY KEY
);

ALTER TABLE gif.audit_chain_locks OWNER TO gif_admin;
REVOKE ALL ON gif.audit_chain_locks FROM PUBLIC;
-- Migration 005's ALTER DEFAULT PRIVILEGES auto-grants SELECT, INSERT on new
-- gif tables to gif_app — revoke it here: the lock table must be reachable
-- only through the SECURITY DEFINER trigger. (The verify block asserts this.)
REVOKE ALL ON gif.audit_chain_locks FROM gif_app;

COMMENT ON TABLE gif.audit_chain_locks IS
    'Serialization points for audit hash-chain writes (migration 016). One row '
    'per month partition; compute_audit_event_hash() takes SELECT FOR UPDATE '
    'on the month''s row before the prev-hash lookup, creating it on first '
    'use. INTENTIONALLY carries no grants — only the SECURITY DEFINER trigger '
    'touches it, so no other role can contend for (or wedge) the chain lock. '
    'Rows accumulate one per month and are never deleted.';

COMMENT ON COLUMN gif.audit_chain_locks.month_start IS
    'UTC month start of the audit_events partition this row serializes. '
    'Derived under the trigger''s pinned TimeZone (UTC).';

-- The audit trail's stamp semantics changed in 016 — record them where an
-- operator will look first.
COMMENT ON COLUMN gif.audit_events.occurred_at IS
    'Server-clock event time and partition key. Since migration 016: rows '
    'stamped (or explicitly supplied) in the current month are re-stamped '
    'with clock_timestamp() under the chain lock; an explicit stamp in '
    'another month''s partition is preserved. Either way the final stamp is '
    'floored to sort strictly after the chain tail it links to (bumps > 1s '
    'raise a pg_notify on ''audit_chain_order_alert''). Not settable by the '
    'application path (migration 002 posture).';

-- ---------------------------------------------------------------------------
-- PART 2: Replace the hash trigger function with the serialized build.
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
SET timezone = 'UTC'
AS $$
DECLARE
    -- Floor bumps larger than this are alarmed on 'audit_chain_order_alert';
    -- benign concurrency bumps are microsecond-scale and stay silent.
    k_floor_alert CONSTANT INTERVAL := INTERVAL '1 second';

    prev_hash     CHAR(64);
    prev_occurred TIMESTAMPTZ;  -- tail row's stamp, for the chain-order floor
    v_month_start TIMESTAMPTZ;  -- this row's partition month (chain scope)
    v_now         TIMESTAMPTZ;
    v_orig        TIMESTAMPTZ;  -- pre-floor stamp, for the alert delta
    cg            TEXT;   -- caller-governance extension body (keys sorted)
    ext           TEXT;   -- extensions keyed object (one entry: caller-governance)
    preimage      TEXT;   -- top-level canonical JSON (keys sorted)
BEGIN
    -- Step 0: stamp the canonical-form version this trigger computes under, so
    -- the row label and the hashed bytes can never disagree. (Unchanged from
    -- migration 015.)
    NEW.canon_version := 'gif-audit/2';

    -- Step 1 (new in 016): serialize this month's chain writes by locking the
    -- month's row in gif.audit_chain_locks, creating it on first use. The
    -- month is derived under the pinned UTC timezone, so every session
    -- derives the same lock row and the same chain scope. Blocks until any
    -- concurrent same-month writer commits; released at transaction end.
    -- Deliberately OUTSIDE every exception handler — see migration header.
    v_month_start := date_trunc('month', NEW.occurred_at);
    LOOP
        PERFORM 1 FROM gif.audit_chain_locks
         WHERE month_start = v_month_start
           FOR UPDATE;
        EXIT WHEN FOUND;
        -- First write of this month: create the lock row, then loop to lock
        -- it. ON CONFLICT covers a concurrent first-writer; if that writer
        -- aborts, the loop's next INSERT attempt succeeds.
        INSERT INTO gif.audit_chain_locks (month_start)
             VALUES (v_month_start)
        ON CONFLICT (month_start) DO NOTHING;
    END LOOP;

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
        v_orig := NEW.occurred_at;
        NEW.occurred_at := LEAST(
            prev_occurred + INTERVAL '1 microsecond',
            v_month_start + INTERVAL '1 month' - INTERVAL '1 microsecond'
        );
        -- A large bump means the chain tail is far ahead of this row's clock
        -- stamp — surface it (see header). Best-effort: never abort the write.
        IF NEW.occurred_at - v_orig > k_floor_alert THEN
            BEGIN
                PERFORM pg_notify(
                    'audit_chain_order_alert',
                    format('Chain-order floor moved event %s forward by %s (from %s to %s)',
                           NEW.event_id, NEW.occurred_at - v_orig, v_orig, NEW.occurred_at)
                );
            EXCEPTION WHEN OTHERS THEN
                NULL;  -- alerting must never block the audit write
            END;
        END IF;
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
-- partitions for the prev-hash lookup — and the lock-table access — with no
-- superuser dependency and no grants to any other role.
ALTER FUNCTION gif.compute_audit_event_hash() OWNER TO gif_admin;

COMMENT ON FUNCTION gif.compute_audit_event_hash() IS
    'BEFORE INSERT trigger function for gif.audit_events. '
    'Serializes chain writes per month partition by locking the month''s row '
    'in gif.audit_chain_locks FOR UPDATE (migration 016; TimeZone pinned to '
    'UTC), re-stamps occurred_at under the lock (confined to the routed '
    'partition month, floored strictly after the chain tail; floor bumps > 1s '
    'notify ''audit_chain_order_alert''), then computes event_hash = '
    'sha256(canonicalize(body)) in the gif-audit/2 extensions-keyed-object '
    'canonical form (migration 015) and stamps canon_version = '
    '''gif-audit/2''. previous_hash links to the newest prior row in the same '
    'month partition. SECURITY DEFINER owned by gif_admin. Never throws — '
    'hash error written as HASH_ERROR with pg_notify on ''audit_chain_error''.';

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    fn_def         TEXT;
    default_expr   TEXT;
    trigger_exists BOOLEAN;
    fn_owner       TEXT;
    r              RECORD;
    ts_from        TIMESTAMPTZ;
    ts_to          TIMESTAMPTZ;
BEGIN
    -- The serialization lock is present in the installed function body.
    SELECT pg_get_functiondef(p.oid) INTO fn_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'gif' AND p.proname = 'compute_audit_event_hash';

    IF fn_def IS NULL
       OR fn_def NOT LIKE '%audit_chain_locks%'
       OR fn_def NOT LIKE '%FOR UPDATE%' THEN
        RAISE EXCEPTION 'compute_audit_event_hash does not take the chain lock';
    END IF;

    -- The lock table exists, and no role beyond its owner can touch it — the
    -- privilege-scoping the serialization design depends on.
    IF NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'gif' AND c.relname = 'audit_chain_locks'
    ) THEN
        RAISE EXCEPTION 'gif.audit_chain_locks not found';
    END IF;

    IF has_table_privilege('gif_app', 'gif.audit_chain_locks', 'SELECT, INSERT, UPDATE, DELETE') THEN
        RAISE EXCEPTION 'gif.audit_chain_locks must carry no grants to gif_app';
    END IF;

    -- TimeZone invariant: every audit_events partition bound must be exactly
    -- a UTC month boundary, or the trigger's UTC-pinned month math would not
    -- match the physical partitions (see header). Fail the migration loudly
    -- rather than let inserts fail (or drop rows) later.
    FOR r IN
        SELECT c.oid::regclass::text AS part,
               pg_get_expr(c.relpartbound, c.oid) AS bound
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'gif.audit_events'::regclass
    LOOP
        IF r.bound = 'DEFAULT' THEN
            RAISE EXCEPTION 'audit_events has a DEFAULT partition (%) — unsupported for the month-scoped hash chain', r.part;
        END IF;

        ts_from := (regexp_match(r.bound, 'FROM \(''([^'']+)''\)'))[1]::timestamptz;
        ts_to   := (regexp_match(r.bound, 'TO \(''([^'']+)''\)'))[1]::timestamptz;

        IF ts_from IS NULL OR ts_to IS NULL THEN
            RAISE EXCEPTION 'could not parse partition bounds for %: %', r.part, r.bound;
        END IF;

        IF ts_from <> (date_trunc('month', ts_from AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
           OR ts_to <> (date_trunc('month', ts_to AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') THEN
            RAISE EXCEPTION 'partition % bounds (%) are not UTC month-aligned — realign partitions (or create them under a UTC session) before applying migration 016', r.part, r.bound;
        END IF;
    END LOOP;

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

    RAISE NOTICE 'Migration 016 verified: chain writes serialized (lock table present, ungranted), partitions UTC month-aligned, canon default = gif-audit/2 (unchanged), trigger intact, owner gif_admin';
END;
$$;

COMMIT;
