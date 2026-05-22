"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
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
const pg_1 = require("pg");
// Single pool instance shared across the process.
// pg manages connection lifecycle — do not create per-request pools.
const pool = new pg_1.Pool({
    host: process.env.PGHOST || process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.PGPORT || process.env.POSTGRES_PORT || '5432'),
    user: process.env.PGUSER || process.env.POSTGRES_USER || 'gif_app',
    password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD,
    database: process.env.PGDATABASE || process.env.POSTGRES_DB || 'gif',
    // Connection pool sizing.
    // Conservative defaults for current single-server deployment.
    // Revisit if concurrent tool call volume increases significantly.
    max: 10, // Maximum concurrent connections
    idleTimeoutMillis: 30000, // Close idle connections after 30s
    connectionTimeoutMillis: 5000, // Fail fast if Postgres is unreachable
});
// Log pool errors — these are background connection errors, not query errors.
// Query errors are handled at the call site.
pool.on('error', (err) => {
    console.error('[db] Unexpected pool error:', err.message);
});
exports.default = pool;
//# sourceMappingURL=db.js.map