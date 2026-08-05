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

// src/db.ts
// =============================================================================
// Postgres connection pool
// Shared singleton used by persona validation and all tool handlers.
// Connection parameters sourced from environment variables set in
// docker-compose.yml — never hardcoded.
//
// Accepts either PG* (libpq canonical) or POSTGRES_* (common in compose stubs).
// PG* takes precedence when both are set.
// =============================================================================

import { Pool } from 'pg';

// Single pool instance shared across the process.
// pg manages connection lifecycle — do not create per-request pools.
const pool = new Pool({
  host:     process.env.PGHOST     || process.env.POSTGRES_HOST     || 'localhost',
  port:     parseInt(process.env.PGPORT || process.env.POSTGRES_PORT || '5432'),
  user:     process.env.PGUSER     || process.env.POSTGRES_USER     || 'gif_app',
  password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD,
  database: process.env.PGDATABASE || process.env.POSTGRES_DB       || 'gif',

  // Connection pool sizing.
  // Conservative defaults for current single-server deployment.
  // Revisit if concurrent tool call volume increases significantly.
  //
  // Known capacity limit: persona_create/persona_revoke hold a dedicated
  // connection for their whole transaction, competing with audit emission on
  // this same shared pool. If >= max persona transactions run concurrently,
  // other callers' audit writes queue and — past connectionTimeoutMillis —
  // fail into logAuditEvent's never-throw catch (a dropped audit row).
  // Persona tools require manage_personas scope, which bounds who can drive
  // that load. Sizing guidance and structural options (reserved audit
  // allotment, per-persona serialization) are ops-runbook material.
  max:            10,   // Maximum concurrent connections
  idleTimeoutMillis: 30000,   // Close idle connections after 30s
  connectionTimeoutMillis: 5000,  // Fail fast if Postgres is unreachable

  // Kill any connection left idle inside an open transaction after 60s —
  // defense in depth behind the dedicated-client transaction pattern in
  // persona_create/persona_revoke. A stranded BEGIN holds its row locks
  // indefinitely, and an audit INSERT that later joins the stale transaction
  // holds the chain-serialization lock (migration 016), blocking every audit
  // write on the database. gif transactions are tight query sequences;
  // legitimate in-transaction idle time is milliseconds, so 60s is enormous
  // headroom against false kills.
  options: '-c idle_in_transaction_session_timeout=60000',
});

// Log pool errors — these are background connection errors, not query errors.
// Query errors are handled at the call site.
pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message);
});

export default pool;
