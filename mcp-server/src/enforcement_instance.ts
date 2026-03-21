// src/enforcement_instance.ts
// =============================================================================
// Module-level enforcement instance for the GIF MCP server.
//
// Calls createEnforcement(pool) once at module load time, binding all
// enforcement functions to the gif_app pool. persona.ts and session.ts
// re-export from here — enforcement.ts is the single implementation.
//
// ADR-027: enforcement.ts is the canonical implementation; this file
// ensures the GIF server itself uses it rather than duplicating the logic.
// =============================================================================

import pool from './db.js';
import { createEnforcement } from './enforcement.js';

export const gif = createEnforcement(pool);
