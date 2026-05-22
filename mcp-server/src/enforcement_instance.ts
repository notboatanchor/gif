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
