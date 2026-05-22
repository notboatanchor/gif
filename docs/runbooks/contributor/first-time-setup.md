# First-Time Setup

Get the full gif stack running locally so you can build and test against a real database and MCP server.

---

## Prerequisites

- **Docker** and **Docker Compose** (Docker Desktop or Docker Engine + Compose plugin)
- **Node.js** v20+ (matches `@types/node: ^20` in `mcp-server/package.json`)
- **git** with SSH access to GitHub (required for the `gif-enforcement` dependency, which adopter repos pin via SSH)

---

## 1. Clone the repository

```bash
# HTTPS (no SSH key required):
git clone https://github.com/notboatanchor/gif.git
# Or SSH:
# git clone git@github.com:notboatanchor/gif.git

cd gif
```

---

## 2. Create `.env`

```bash
cp .env.example .env
```

Open `.env` and set real values for every variable. The defaults (`changeme`) will break the MCP server. In particular:

| Variable | What it is |
|---|---|
| `POSTGRES_PASSWORD` | Docker-managed `postgres` superuser |
| `GIF_ADMIN_PASSWORD` | `gif_admin` — schema owner and migration runner |
| `GIF_APP_PASSWORD` | `gif_app` — application user, used by the MCP server and tests |
| `IDENTITY_HMAC_SECRET` | HMAC secret for identity token signing — generate with `openssl rand -hex 32` |

`.env` is gitignored. Never commit it.

---

## 3. Start the stack

```bash
docker compose up -d --build
```

This starts two services:

- **postgres** — PostgreSQL 16, initializes the database on first run
- **mcp-server** — the GIF MCP server, waits for postgres to pass its healthcheck before starting

On a fresh volume, `init-db.sh` runs automatically inside the postgres container. It applies all 12 migrations in sequence and records each one in `gif.schema_migrations`.

---

## 4. Verify the database initialized cleanly

Check the init output:

```bash
docker compose logs postgres
```

A clean init looks like:

```
=== GIF Database Init ===
    Database: gif

  1/3  Bootstrap
  2/3  Passwords
  3/3  Migrations
       → 001_gif_core.sql (applying)
         001_gif_core.sql applied.
       → 002_gif_core.sql (applying)
         ...
       → 012_schema_migrations.sql (applying)
         012_schema_migrations.sql applied.

=== GIF Init Complete ===
```

If any migration fails, `init-db.sh` exits with a non-zero status (it runs with `set -euo pipefail`) and the postgres container will report an error. Check the full log for the failing migration name and the SQL error.

To verify the MCP server connected successfully:

```bash
docker compose logs mcp-server
```

---

## 5. Install Node dependencies and build

```bash
cd mcp-server
npm install
npm run build
```

---

## 6. Run the test suite

Use the helper script — it sources `.env`, sets the host variables, and runs `npm test`:

```bash
./scripts/test-local.sh
```

`npm test` runs all test files in sequence: `test_setup`, `test_mcp`, `test_audit_trail`, `test_delegation`, `test_hash_chain`, `test_identity_binding`, `test_read_log`, `test_retention`, and `test_combination_policies`.

### Port conflicts

If port 3100 is already in use on your machine (e.g., another gif deployment is running), set `PORT` in `.env` to a free port — for example, `PORT=3199`. The helper script reads `PORT` from `.env` and constructs `MCP_BASE_URL` automatically, so tests connect to the right server. Apply the same approach for `PGPORT_HOST` if port 5432 is taken.

---

## 7. Tear down and reset

**Stop the stack (keep data):**

```bash
docker compose down
```

**Full reset — drops all data and re-runs init from scratch:**

```bash
docker compose down -v
docker compose up -d
```

`docker compose down -v` removes the `postgres_data` volume. The next `up` runs `init-db.sh` again against an empty volume, applying all 12 migrations fresh.

This is the canonical way to test a clean install or verify a new migration applies correctly from zero.
