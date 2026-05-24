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

-- Migration 013: repurpose gif.sessions for v0.2 governance handles (GIF-021).
--
-- No DDL changes, no row changes, no FK changes. This migration updates
-- Postgres system-catalog comments on the existing gif.sessions table and
-- its v0.2-relevant columns to reflect the semantics specified by:
--
--   GIF-019 — session_start mints the handle; gif_session_id propagates
--             as an explicit tool argument.
--   GIF-020 — closure semantics: caller-close (session_close tool) OR
--             hard wall-clock TTL via GIF_SESSION_TTL_SECONDS, lazy
--             expiry, no inactivity timeout in v0.2.0.
--   GIF-021 — repurpose-in-place schema decision (this migration).
--
-- v0.1 rows are preserved: every existing sessions row was minted and
-- closed in the same v0.1 dispatch handler, so all rows have ended_at !=
-- NULL and naturally read as closed sessions under v0.2's
-- "ended_at IS NULL = active" predicate. TRUNCATE is not used — every
-- sessions row is FK-referenced by audit_events; cascade-deleting audit
-- rows would violate the append-only audit-trail non-negotiable
-- (GIF-003).
--
-- Idempotent: COMMENT ON overwrites prior comments and can be re-run.

BEGIN;

COMMENT ON TABLE gif.sessions IS
    'Governance session rows minted by the session_start MCP tool '
    '(GIF-019). One row represents one logical work session whose '
    'combination-policy source accumulation is scoped to a single '
    'gif_session_id. Lifecycle is caller-close (session_close tool) '
    'or hard wall-clock TTL via GIF_SESSION_TTL_SECONDS (GIF-020).';

COMMENT ON COLUMN gif.sessions.started_at IS
    'Session mint timestamp. Basis for TTL expiry under GIF-020: '
    'now() > started_at + GIF_SESSION_TTL_SECONDS rejects with '
    'SESSION_EXPIRED on the next governed call.';

COMMENT ON COLUMN gif.sessions.ended_at IS
    'Null while the session is active OR after TTL-driven dormancy '
    'with no subsequent governed call (GIF-020 path 3). Set to now() '
    'only by the session_close tool handler. Note: ended_at IS NULL '
    'does not imply "active" — combine with started_at + TTL to '
    'determine effective state.';

COMMENT ON COLUMN gif.sessions.invocation_context IS
    'Adopter-supplied free-form session metadata, captured at '
    'session_start and immutable thereafter. Snapshot semantics — '
    'supports point-in-time reconstruction of caller-declared '
    'session intent independent of subsequent state changes.';

COMMIT;
