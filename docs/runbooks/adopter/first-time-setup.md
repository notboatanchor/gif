# GIF First-Time Setup

Audience: an operator standing up gif for the first time in their own environment.

gif runs as two Docker containers — a PostgreSQL database and an MCP server. The
database initializes itself on first start. You do not need to run any SQL by hand.

---

## 1. Prerequisites

- Docker Engine 24+ and Docker Compose v2 (`docker compose` — not `docker-compose`)
- Git (to clone the repo)
- A PostgreSQL client (`psql`) — optional, useful for verifying the schema after init

---

## 2. Get the code

Clone at a tagged release. Always pin to a tag — never run from a floating branch
in any environment that handles real audit data.

```bash
# HTTPS (no SSH key required):
git clone --branch v0.1.0 https://github.com/notboatanchor/gif.git
# Or SSH:
# git clone --branch v0.1.0 git@github.com:notboatanchor/gif.git

cd gif
```

---

## 3. Create `.env`

Copy the example file and fill in every value before starting.

```bash
cp .env.example .env
```

Required variables — descriptions from `.env.example`:

| Variable | Purpose | Default |
|---|---|---|
| `POSTGRES_PASSWORD` | PostgreSQL superuser (`postgres`) password | none |
| `GIF_ADMIN_PASSWORD` | `gif_admin` role — schema owner, migration user | none |
| `GIF_APP_PASSWORD` | `gif_app` role — MCP server runtime user | none |
| `PGDATABASE` | Database name | `gif` |
| `PGPORT_HOST` | Host-side port PostgreSQL is exposed on | `5432` |
| `PORT` | Host-side port the MCP server listens on | `3100` |
| `IDENTITY_HMAC_SECRET` | HMAC secret for identity token signing | none |

Generate a strong `IDENTITY_HMAC_SECRET`:

```bash
openssl rand -hex 32
```

Use a distinct, strong password for each of `POSTGRES_PASSWORD`, `GIF_ADMIN_PASSWORD`,
and `GIF_APP_PASSWORD`. Do not commit `.env` — it is gitignored.

---

## 4. Start gif

```bash
docker compose up -d --build
```

On first start, `init-db.sh` runs automatically inside the PostgreSQL container and:

1. Creates the `gif_admin` and `gif_app` roles and the `gif` schema.
2. Sets role passwords from your env vars.
3. Applies all schema migrations in order, recording each one in
   `gif.schema_migrations`.

Subsequent starts skip already-applied migrations.

---

## 5. Verify initialization

Check that both containers started cleanly:

```bash
docker compose ps
```

Both `postgres` and `mcp-server` should show `running` (or `healthy`).

Tail the init log to confirm all migrations applied:

```bash
docker compose logs postgres
```

Look for the final line:

```
=== GIF Init Complete ===
```

Confirm all migrations are recorded (requires `psql`; adjust port/password as needed):

```bash
PGPASSWORD=<GIF_ADMIN_PASSWORD> psql \
  -h localhost -p 5432 -U gif_admin -d gif \
  -c "SELECT migration_name, applied_at FROM gif.schema_migrations ORDER BY applied_at;"
```

You should see 12 rows — `001_gif_core.sql` through `012_schema_migrations.sql`.

Verify the MCP server is accepting connections:

```bash
curl -s http://localhost:3100/health
```

Expected response: `{"status":"ok","service":"gif-mcp-server"}`

---

## 6. Wire your tool server

In your adopter tool server, add `gif-enforcement` as a pinned git dependency:

```bash
npm install "git+ssh://git@github.com/notboatanchor/gif.git#v0.1.0"
```

This adds the following to your `package.json`:

```json
"dependencies": {
  "gif-enforcement": "git+ssh://git@github.com/notboatanchor/gif.git#v0.1.0"
}
```

> **Release candidate.** Adopters tracking the MCP 2026-07-28 spec can pin to
> `#v0.2.0-rc.1` instead. The v0.2 substrate uses the MCP SDK 2.0 split-package
> layout (ESM-only) and changes the tool-call contract to require an explicit
> `gif_session_id`. See [`docs/migrations/v0.1-to-v0.2.md`](../../migrations/v0.1-to-v0.2.md)
> for the full adopter contract — package.json changes, the `@cfworker/json-schema`
> peer dep, ESM requirement, and `v0.1 → v0.2` import map.

In your server code, inject your own `pg.Pool` into `createEnforcement`. gif
enforcement runs under whichever credentials your pool uses — do not modify gif
source code.

```typescript
import { createEnforcement } from 'gif-enforcement';
import { Pool } from 'pg';

const pool = new Pool({
  host:     process.env.PGHOST,
  port:     Number(process.env.PGPORT),
  database: process.env.PGDATABASE,
  user:     process.env.PGUSER,     // gif_app (or your adopter app role)
  password: process.env.PGPASSWORD,
});

export const { validatePersona, createSession, closeSession, logAuditEvent }
  = createEnforcement(pool);
```

Your tool handlers call `validatePersona` before executing any tool logic.
Enforcement happens at the MCP layer — do not duplicate permission checks in
application code.

---

## 7. Build your tool handlers

Each action you want to expose to the AI is a separate handler — one handler per
discrete operation. For example: `app_search`, `app_create_entry`, `app_update_status`,
`app_delete` are four handlers, not one handler with an `action` parameter.

**Why granularity matters:** Persona scope is enforced at the tool level. If
`app_search` and `app_delete` are the same tool, you cannot scope a Persona to
search-only. Granular handlers are what make Persona scope constraints meaningful
at the action level.

Each handler follows the same structure:
1. Zod-validated input schema (what parameters the AI can pass)
2. `validatePersona` check (enforcement, runs before any application logic)
3. Application logic (API call, database query, or any other operation)
4. Response returned through MCP

The reference implementation in `mcp-server/src/tools/` demonstrates this pattern.
`db_read.ts` and `db_write.ts` are adopter-layer tools — read them as templates for
building your own handlers.

Register each handler in your `registry.ts` and seed a corresponding row in the
`tool_registry` database table. If a tool is not registered and active in both
places, it does not exist from the AI's perspective — the request will never route
to it.

---

## 8. Manage application secrets

Each tool handler has access to `process.env` at runtime. API keys, tokens, and
credentials required by your application tools belong in environment variables —
not in the GIF database, and not hardcoded in handler source.

**Development:** Add your application secrets to the `.env` file alongside the GIF
database credentials. The `.env` file is gitignored and never committed.

```
# GIF credentials (already present)
GIF_APP_PASSWORD=...
IDENTITY_HMAC_SECRET=...

# Your application secrets
APP_API_KEY=...
APP_API_BASE_URL=...
```

**Production:** `.env` is a development convenience. In production environments,
secrets should come from your infrastructure's secret management system (AWS
Secrets Manager, HashiCorp Vault, Kubernetes Secrets, or equivalent). The
mechanism is the adopter's responsibility — GIF does not manage application
credentials. Whatever system you use, secrets must be present as environment
variables in the MCP server process at startup.

GIF's governance scope covers what the AI does with its tools. Credential
management for those tools is the adopter's operational concern.

---

## 9. Bootstrap the first persona

A fresh GIF installation has zero personas and zero user-persona assignments.
This means `persona_create` cannot be the first call into a new deployment —
it has three preconditions that the schema migrations do not seed for you:

1. **An issuing persona** with `manage_personas` in `permitted_actions` must
   already exist. `persona_create` requires `persona_id` to point at an active,
   approved persona that holds this permission.
2. **A `user_persona_assignments` row** binding an external user identity to
   the issuing persona must exist. `persona_create` requires `identity_token`,
   and `identity_token` is HMAC-derived from an `assignment_id` that must
   reference a real row.
3. **An unconsumed HMAC token** issued from that assignment. Tokens are
   single-use: each `user_persona_assignments` row yields exactly one
   `persona_create` call. `gif_app` cannot un-consume a token — the
   `upa_consume_token_gif_app` policy only allows `token_consumed: false→true`.

The bootstrap therefore requires a one-time direct-SQL seed as `gif_admin`,
bypassing the HMAC flow that `gif_app` is constrained by. Every subsequent
persona is created through `persona_create` with a fresh token.

**Step 1 — Seed the bootstrap admin persona** (direct SQL as `gif_admin`):

```bash
PGPASSWORD=<GIF_ADMIN_PASSWORD> psql \
  -h localhost -p 5432 -U gif_admin -d gif <<'SQL'
INSERT INTO gif.personas (
    issuing_entity,
    purpose,
    created_by,
    scope_definition,
    valid_until,
    status,
    max_delegation_depth,
    governance_review_status
) VALUES (
    '<adopter-name>',
    'Bootstrap admin — provisions operational personas',
    '<adopter-name>-bootstrap',
    '{
       "permitted_actions":  ["manage_personas"],
       "permitted_sources":  ["tool_registry"],
       "output_destinations": ["user_persona_assignments"],
       "max_results": 100
    }'::jsonb,
    now() + interval '10 years',
    'active',
    1,
    'approved'
)
RETURNING persona_id;
SQL
```

Capture the returned `persona_id` — call it `<BOOTSTRAP_ADMIN_PERSONA_ID>`.

The `scope_definition` above is intentionally minimal. The bootstrap admin
exists for one job: create the personas your application actually uses. It
should not carry read/write scope to application data.

**Step 2 — Create an assignment row for every persona you intend to provision**:

Each `persona_create` call consumes one assignment row's token. If you plan to
provision N personas at bootstrap (e.g., one read-only persona, one
read+write persona, one audit-reader persona), seed N assignment rows now.

```bash
PGPASSWORD=<GIF_ADMIN_PASSWORD> psql \
  -h localhost -p 5432 -U gif_admin -d gif <<'SQL'
INSERT INTO gif.user_persona_assignments (
    external_user_id,
    persona_id,
    assigned_by,
    purpose_for_assignment
) VALUES
    ('<admin-external-user-id>', '<BOOTSTRAP_ADMIN_PERSONA_ID>',
     '<adopter-name>-bootstrap', 'Provision read-only persona'),
    ('<admin-external-user-id>', '<BOOTSTRAP_ADMIN_PERSONA_ID>',
     '<adopter-name>-bootstrap', 'Provision read+write persona'),
    ('<admin-external-user-id>', '<BOOTSTRAP_ADMIN_PERSONA_ID>',
     '<adopter-name>-bootstrap', 'Provision audit-reader persona')
RETURNING assignment_id, purpose_for_assignment;
SQL
```

`external_user_id` is opaque to GIF — it is your reference to whichever
identity system your application uses (IdP subject, directory ID, internal
user UUID). GIF stores it without interpreting it. See ADR-021 for the
identity binding model.

Capture the returned `assignment_id` values.

**Step 3 — Mint an HMAC token from each assignment**:

```bash
cd mcp-server
npx ts-node src/cli/issue_identity_token.ts \
  --assignment-id <ASSIGNMENT_ID_FROM_STEP_2>
```

The CLI prints a single token to stdout. Tokens are valid for 15 minutes from
issuance. `IDENTITY_HMAC_SECRET` must be set in the environment (source your
`.env` or export it directly).

**Step 4 — Call `persona_create` with the issuing persona and the token**:

For each persona you want to provision, call the MCP `persona_create` tool with:

- `persona_id`: `<BOOTSTRAP_ADMIN_PERSONA_ID>` (the issuer with `manage_personas`)
- `identity_token`: the token from Step 3
- `purpose`, `issuing_entity`, `scope_definition`, `valid_until`,
  `max_delegation_depth`: the new persona's own definition (see the
  `persona_create` tool schema or `mcp-server/src/tools/persona_create.ts`).

Each `persona_create` call:
- consumes one assignment row's token (flips `token_consumed: false→true`)
- creates one new persona
- records an audit event with `human_actor_id = <assignment_id>` — linking
  the new persona back to the verified human identity that authorized it

**Step 5 — Ongoing provisioning** (after bootstrap):

To create additional personas later, repeat Steps 2–4 against the bootstrap
admin (or any persona you've created with `manage_personas` in its scope).
Direct-SQL inserts as `gif_admin` are the bootstrap exception — they are not
the steady-state provisioning path. After the first persona exists, all
provisioning goes through `persona_create`.

---

## 10. Smoke test

With gif running and the first persona provisioned, verify the core path
end-to-end.

**Execute a tool call** through your adopter server with the new persona ID.

**Verify the audit event was recorded:**

```bash
PGPASSWORD=<GIF_APP_PASSWORD> psql \
  -h localhost -p 5432 -U gif_app -d gif \
  -c "SELECT persona_id, tool_name, outcome, recorded_at
      FROM gif.audit_events
      ORDER BY recorded_at DESC
      LIMIT 5;"
```

You should see a row for the tool call you just made. The audit trail is
INSERT-only at the database permission level — `gif_app` cannot UPDATE or DELETE
these rows.

---

## Installing into an existing database

The steps above use Docker to create a fresh database named `gif`. If you are
installing GIF into an existing PostgreSQL database that already has an owner and
other schemas, follow this path instead.

**When to use this path:**
- Your application already has a PostgreSQL database and you want to add GIF
  governance alongside your existing schemas.
- You are installing GIF on a managed service (RDS, Cloud SQL, Supabase) where
  you do not create a dedicated GIF database.

**Prerequisites**

1. The database must exist. GIF does not create databases — only schemas within them.

2. Run the following as the database superuser or database owner before executing
   the bootstrap. This gives `gif_admin` the right to create the `gif` schema:

   ```sql
   CREATE ROLE gif_admin WITH LOGIN PASSWORD '<gif_admin_password>';
   CREATE ROLE gif_app   WITH LOGIN PASSWORD '<gif_app_password>';
   GRANT CREATE ON DATABASE <your_database> TO gif_admin;
   ```

   If `gif_admin` and `gif_app` already exist on this Postgres instance (e.g.,
   GIF is already installed in another database on the same server), skip the
   `CREATE ROLE` lines.

**Run bootstrap (existing database path)**

Omit `-v gif_dedicated_db=on`. This skips the database ownership transfer —
`gif_admin` owns only the `gif` schema.

```bash
PGPASSWORD=<superuser_password> psql \
  -h <host> -p <port> -U <superuser> -d <your_database> \
  -v ON_ERROR_STOP=1 \
  -f gif/schema/000_bootstrap.sql
```

**Set role passwords**

```sql
ALTER ROLE gif_admin PASSWORD '<gif_admin_password>';
ALTER ROLE gif_app   PASSWORD '<gif_app_password>';
```

**Run GIF schema migrations**

Run each migration in order as `gif_admin`:

```bash
for f in gif/schema/001_gif_core.sql \
          gif/schema/002_gif_core.sql \
          gif/schema/003_gif_erasure_log.sql \
          gif/schema/004_tool_registry_sprint4.sql \
          gif/schema/005_schema_separation.sql \
          gif/schema/006_audit_hash_chain.sql \
          gif/schema/007_identity_binding.sql \
          gif/schema/008_audit_read_log.sql \
          gif/schema/009_retention_lifecycle.sql \
          gif/schema/010_combination_policies.sql; do
  PGPASSWORD=<gif_admin_password> psql \
    -h <host> -p <port> -U gif_admin -d <your_database> \
    -v ON_ERROR_STOP=1 -f "$f"
done
```

**Verify**

```sql
SELECT migration_name, applied_at
FROM gif.schema_migrations
ORDER BY applied_at;
```

You should see 12 rows. The `gif` schema now coexists with your existing schemas.
Your existing schemas and their owners are unaffected.

**Configure your MCP server**

Set `PGDATABASE=<your_database>` in your MCP server environment. The `gif` schema
name is fixed (GIF-016) — the database name is your choice.
