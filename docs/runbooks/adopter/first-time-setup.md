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
git clone --branch v0.1.0 git@github.com:scottrhodes/gif.git
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
npm install "git+ssh://git@github.com/scottrhodes/gif.git#v0.1.0"
```

This adds the following to your `package.json`:

```json
"dependencies": {
  "gif-enforcement": "git+ssh://git@github.com/scottrhodes/gif.git#v0.1.0"
}
```

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

## 7. Smoke test

With gif running, verify the core path end-to-end.

**Create a persona** via the MCP `persona_create` tool. Every persona requires a
non-nullable `purpose` field — this is a schema constraint, not policy.

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
