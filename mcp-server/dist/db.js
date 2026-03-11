"use strict";
// src/db.ts
// =============================================================================
// Postgres connection pool
// Shared singleton used by persona validation and all tool handlers.
// Connection parameters sourced from environment variables set in
// docker-compose.yml — never hardcoded.
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
const pg_1 = require("pg");
// Single pool instance shared across the process.
// pg manages connection lifecycle — do not create per-request pools.
const pool = new pg_1.Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    user: process.env.POSTGRES_USER || 'gif_app',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'gif_research',
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